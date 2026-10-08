// lineage_bench for cosmos/go-bip39 (overlay, protected). Usage: bip39bench <mnemonic|entropy|valid> <seed>
// Run under callgrind with GOMAXPROCS=1 GOGC=off GODEBUG=asyncpreemptoff=1. Inputs depend only on the seed.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"os"
	"strings"

	bip39 "github.com/cosmos/go-bip39"
)

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func rng(seed string) *rand.Rand {
	h := sha256.Sum256([]byte(seed + "/bench"))
	return rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[0:8]), binary.LittleEndian.Uint64(h[8:16])))
}

var sizes = []int{16, 20, 24, 28, 32}

func entropies(r *rand.Rand, n int) [][]byte {
	out := make([][]byte, n)
	for i := range out {
		b := make([]byte, sizes[r.IntN(len(sizes))])
		for j := range b {
			b[j] = byte(r.Uint32())
		}
		// a few entropies with leading zero bytes (short big.Int encodings)
		if r.IntN(8) == 0 {
			b[0] = 0
			if r.IntN(2) == 0 {
				b[1] = 0
			}
		}
		out[i] = b
	}
	return out
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: bip39bench <mnemonic|entropy|valid> <seed>")
		os.Exit(2)
	}
	mode, seed := os.Args[1], os.Args[2]
	r := rng(seed)
	ents := entropies(r, 400)
	var phrases []string
	if mode != "mnemonic" {
		for _, e := range ents {
			p, err := bip39.NewMnemonic(e)
			must(err)
			// a share of phrases with one word swapped (checksum failures)
			if r.IntN(4) == 0 {
				w := strings.Split(p, " ")
				w[r.IntN(len(w))] = bip39.WordList[r.IntN(2048)]
				p = strings.Join(w, " ")
			}
			phrases = append(phrases, p)
		}
	}
	procPin()
	sum := run(mode, ents, phrases)
	procUnpin()
	fmt.Println(mode, sum)
}

// run is the measured region: the recipe's metric collects instructions only inside it
// (callgrind --toggle-collect=main.run), so input generation and runtime start-up are excluded.
//
//go:noinline
func run(mode string, ents [][]byte, phrases []string) uint32 {
	var sum uint32
	switch mode {
	case "mnemonic":
		for round := 0; round < 2; round++ {
			for _, e := range ents {
				p, err := bip39.NewMnemonic(e)
				must(err)
				sum = sum*31 + uint32(len(p)) + uint32(p[len(p)-1])
			}
		}
	case "entropy":
		for round := 0; round < 2; round++ {
			for _, p := range phrases {
				b, err := bip39.MnemonicToByteArray(p)
				if err != nil {
					sum = sum*31 + 1
					continue
				}
				sum = sum*31 + uint32(len(b)) + uint32(b[len(b)-1])
			}
		}
	case "valid":
		for round := 0; round < 4; round++ {
			for _, p := range phrases {
				if bip39.IsMnemonicValid(p) {
					sum = sum*31 + 1
				} else {
					sum = sum*31 + 2
				}
			}
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown mode", mode)
		os.Exit(2)
	}
	return sum
}
