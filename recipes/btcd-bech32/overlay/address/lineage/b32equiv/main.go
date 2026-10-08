// lineage_equiv for btcd address/bech32 (overlay, protected). Usage: b32equiv <seed>
// Prints the observable result (values, version, error type and text) of every exported function
// on seeded inputs and edge cases: segwit-shaped and generic strings, upper and mixed case,
// corrupted characters, bad separators, out-of-range characters and data bytes, length limits,
// every bit-group pair for ConvertBits with and without padding.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/rand/v2"
	"os"

	"github.com/btcsuite/btcd/address/v2/bech32"
)

const cs = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"

func e(err error) string {
	if err == nil {
		return "nil"
	}
	return fmt.Sprintf("%T %q", err, err.Error())
}

func main() {
	h := sha256.Sum256([]byte(os.Args[1] + "/equiv"))
	r := rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[0:8]), binary.LittleEndian.Uint64(h[8:16])))
	rb := func(n int, bits uint) []byte {
		b := make([]byte, n)
		for i := range b {
			b[i] = byte(r.Uint32()) & byte((1<<bits)-1)
		}
		return b
	}
	hrpChars := "abcdefghijklmnopqrstuvwxyz0123456789!#$%&*+-./:;<=>?@[]^_{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	var good []string
	for i := 0; i < 300; i++ {
		hrp := make([]byte, 1+r.IntN(15))
		for j := range hrp {
			hrp[j] = hrpChars[r.IntN(len(hrpChars))]
		}
		data := rb(r.IntN(70), 5)
		if r.IntN(10) == 0 && len(data) > 0 {
			data[r.IntN(len(data))] = byte(32 + r.IntN(224))
		}
		s0, err0 := bech32.Encode(string(hrp), data)
		sm, errm := bech32.EncodeM(string(hrp), data)
		fmt.Printf("enc %d %q %s %q %s\n", i, s0, e(err0), sm, e(errm))
		if err0 == nil {
			good = append(good, s0, sm)
		}
	}
	for i := 0; i < 200; i++ {
		b := rb(r.IntN(50), 8)
		s, err := bech32.EncodeFromBase256([]string{"bc", "tb", "lnbc", "X"}[r.IntN(4)], b)
		fmt.Printf("enc256 %d %q %s\n", i, s, e(err))
		if err == nil {
			good = append(good, s)
		}
	}
	mutate := func(s string) string {
		b := []byte(s)
		if len(b) == 0 {
			return "1"
		}
		j := r.IntN(len(b))
		switch r.IntN(8) {
		case 0:
			b[j] = cs[r.IntN(32)]
		case 1:
			b = append(b[:j], b[j+1:]...)
		case 2:
			ins := "1bioBIO \x7f\x80~"
			b = append(b[:j], append([]byte{ins[r.IntN(len(ins))]}, b[j:]...)...)
		case 3:
			if b[j] >= 'a' && b[j] <= 'z' {
				b[j] -= 32
			} else if b[j] >= 'A' && b[j] <= 'Z' {
				b[j] += 32
			}
		case 4:
			for k := range b {
				if b[k] >= 'a' && b[k] <= 'z' {
					b[k] -= 32
				}
			}
		case 5:
			b = b[:r.IntN(len(b)+1)]
		case 6:
			b = append(b, b...)
		default:
			if j+1 < len(b) {
				b[j], b[j+1] = b[j+1], b[j]
			}
		}
		return string(b)
	}
	for i, s := range good {
		for k := 0; k < 3; k++ {
			x := s
			if k > 0 {
				x = mutate(s)
			}
			hrp, d, err := bech32.Decode(x)
			fmt.Printf("dec %d %d %q %x %s\n", i, k, hrp, d, e(err))
			hrp, d, v, err := bech32.DecodeGeneric(x)
			fmt.Printf("gen %d %d %q %x %d %s\n", i, k, hrp, d, v, e(err))
			hrp, d, v, err = bech32.DecodeNoLimitWithVersion(x)
			fmt.Printf("nol %d %d %q %x %d %s\n", i, k, hrp, d, v, e(err))
			hrp, d, err = bech32.DecodeNoLimit(x)
			fmt.Printf("nl %d %d %q %x %s\n", i, k, hrp, d, e(err))
			hrp, d, err = bech32.DecodeToBase256(x)
			fmt.Printf("d256 %d %d %q %x %s\n", i, k, hrp, d, e(err))
		}
	}
	for i := 0; i < 400; i++ {
		from, to := uint8(r.IntN(10)), uint8(r.IntN(10))
		in := rb(r.IntN(40), 8)
		if from >= 1 && from <= 8 && r.IntN(3) > 0 {
			for j := range in {
				in[j] &= byte((1 << from) - 1)
			}
		}
		for _, pad := range []bool{true, false} {
			out, err := bech32.ConvertBits(in, from, to, pad)
			fmt.Printf("cb %d %d %d %v %s %x %v %s\n", i, from, to, pad, hex.EncodeToString(in), out, out == nil, e(err))
		}
	}
	long := make([]byte, 100)
	for i := range long {
		long[i] = 'q'
	}
	for _, s := range []string{"", "a1", "a1qqqqqq", "1qqqqqqq", "A1LQFN3A", "a12uel5l", "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw", "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w", "?1ezyfcl", "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs", "bc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj", "x1b4n0q5v", "li1dgmt3", "de1lg7wt\xff", "A1G7SGD8", "10a06t8", "1qzzfhee", string(long), "bc1" + string(long[:80])} {
		hrp, d, v, err := bech32.DecodeNoLimitWithVersion(s)
		fmt.Printf("edge %q %q %x %d %s\n", s, hrp, d, v, e(err))
		hrp, d, err = bech32.Decode(s)
		fmt.Printf("edged %q %q %x %s\n", s, hrp, d, e(err))
	}
}
