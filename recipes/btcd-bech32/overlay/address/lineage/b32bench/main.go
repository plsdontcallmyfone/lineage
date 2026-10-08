// lineage_bench for btcd address/bech32 (overlay, protected). Usage: b32bench <encode|decode|convert> <seed>
// Run under callgrind with GOMAXPROCS=1 GOGC=off GODEBUG=asyncpreemptoff=1. Inputs depend only on the seed.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"os"

	"github.com/btcsuite/btcd/address/v2/bech32"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

type item struct {
	hrp  string
	ver  byte
	prog []byte
}

// segwit-shaped programs: P2WPKH (v0, 20 bytes), P2WSH (v0, 32), P2TR (v1, 32), other versions
func items(r *rand.Rand, n int) []item {
	hrps := []string{"bc", "tb", "bcrt"}
	out := make([]item, n)
	for i := range out {
		k := r.IntN(100)
		var v byte
		var ln int
		switch {
		case k < 40:
			v, ln = 0, 20
		case k < 60:
			v, ln = 0, 32
		case k < 95:
			v, ln = 1, 32
		default:
			v, ln = byte(2+r.IntN(15)), 2+r.IntN(39)
		}
		p := make([]byte, ln)
		for j := range p {
			p[j] = byte(r.Uint32())
		}
		out[i] = item{hrps[r.IntN(len(hrps))], v, p}
	}
	return out
}

func encode(it item) string {
	conv, err := bech32.ConvertBits(it.prog, 8, 5, true)
	must(err)
	data := append([]byte{it.ver}, conv...)
	var s string
	if it.ver == 0 {
		s, err = bech32.Encode(it.hrp, data)
	} else {
		s, err = bech32.EncodeM(it.hrp, data)
	}
	must(err)
	return s
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: b32bench <encode|decode|convert> <seed>")
		os.Exit(2)
	}
	mode, seed := os.Args[1], os.Args[2]
	h := sha256.Sum256([]byte(seed + "/bench"))
	r := rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[0:8]), binary.LittleEndian.Uint64(h[8:16])))
	its := items(r, 600)
	var strs []string
	if mode == "decode" {
		for _, it := range its {
			s := []byte(encode(it))
			if r.IntN(4) == 0 { // upper-case form (QR codes)
				for j := range s {
					if s[j] >= 'a' && s[j] <= 'z' {
						s[j] -= 32
					}
				}
			}
			if r.IntN(8) == 0 { // one corrupted data character: checksum failure
				j := len(it.hrp) + 1 + r.IntN(len(s)-len(it.hrp)-1)
				if s[j] == 'q' || s[j] == 'Q' {
					s[j]++
				} else {
					s[j] = 'q'
				}
			}
			strs = append(strs, string(s))
		}
	}
	var blobs [][]byte
	if mode == "convert" {
		for _, it := range its {
			blobs = append(blobs, it.prog)
		}
	}
	procPin()
	sum := run(mode, its, strs, blobs)
	procUnpin()
	fmt.Println(mode, sum)
}

// run is the measured region: the recipe's metric collects instructions only inside it
// (callgrind --toggle-collect=main.run), so input generation and runtime start-up are excluded.
//
//go:noinline
func run(mode string, its []item, strs []string, blobs [][]byte) uint32 {
	var sum uint32
	switch mode {
	case "encode":
		for round := 0; round < 2; round++ {
			for _, it := range its {
				s := encode(it)
				sum = sum*31 + uint32(len(s)) + uint32(s[len(s)-1])
			}
		}
	case "decode":
		for round := 0; round < 2; round++ {
			for _, s := range strs {
				hrp, data, v, err := bech32.DecodeGeneric(s)
				if err != nil {
					sum = sum*31 + uint32(len(err.Error()))
					continue
				}
				prog, err := bech32.ConvertBits(data[1:], 5, 8, false)
				must(err)
				sum = sum*31 + uint32(len(hrp)) + uint32(v) + uint32(len(prog)) + uint32(prog[0])
			}
		}
	case "convert":
		for round := 0; round < 3; round++ {
			for _, b := range blobs {
				c, err := bech32.ConvertBits(b, 8, 5, true)
				must(err)
				d, err := bech32.ConvertBits(c, 5, 8, false)
				must(err)
				sum = sum*31 + uint32(len(c)) + uint32(c[0]) + uint32(len(d))
			}
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown mode", mode)
		os.Exit(2)
	}
	return sum
}
