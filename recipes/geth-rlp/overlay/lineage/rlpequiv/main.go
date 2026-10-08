// lineage_equiv for go-ethereum/rlp (overlay, protected). Usage: rlpequiv <seed>
// Prints a digestible transcript of encodings, round trips and decode errors for seeded inputs,
// including malformed and truncated encodings, so behaviour changes the tests miss show up.
package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"math/big"
	"os"

	"github.com/ethereum/go-ethereum/lineage/internal/gen"
	"github.com/ethereum/go-ethereum/rlp"
	"github.com/holiman/uint256"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: rlpequiv <seed>")
		os.Exit(2)
	}
	r := gen.Rng(os.Args[1], "equiv")
	h := sha256.New()
	line := func(format string, a ...any) { fmt.Fprintf(h, format+"\n", a...) }
	for i := 0; i < 200; i++ {
		blk := gen.NewBlock(r, r.IntN(6))
		enc, err := rlp.EncodeToBytes(&blk)
		line("enc %d %x %v", i, enc, err)
		var back gen.Block
		err = rlp.DecodeBytes(enc, &back)
		re, _ := rlp.EncodeToBytes(&back)
		line("rt %d %v %v", i, err, bytes.Equal(re, enc))
		line("val %d %+v", i, back.Header)
		// mutate: truncate, flip a byte, append garbage; record the exact decode outcome
		for k := 0; k < 6; k++ {
			m := append([]byte(nil), enc...)
			switch k % 3 {
			case 0:
				m = m[:r.IntN(len(m)+1)]
			case 1:
				if len(m) > 0 {
					m[r.IntN(len(m))] ^= byte(1 + r.IntN(255))
				}
			case 2:
				m = append(m, byte(r.Uint32()))
			}
			var out gen.Block
			err := rlp.DecodeBytes(m, &out)
			line("mut %d %d %v", i, k, err)
			k2, _, _, serr := rlp.Split(m)
			n, cerr := rlp.CountValues(m)
			line("raw %d %d %v %v %d %v", i, k, k2, serr, n, cerr)
		}
	}
	// scalar edge cases
	for i := 0; i < 2000; i++ {
		u := r.Uint64() >> uint(r.IntN(64))
		eu, _ := rlp.EncodeToBytes(u)
		var du uint64
		line("u %d %x %v %d %x", u, eu, rlp.DecodeBytes(eu, &du), du, rlp.AppendUint64(nil, u))
		b := new(big.Int).SetBytes(bytes.Repeat([]byte{byte(r.Uint32())}, r.IntN(40)))
		eb, err := rlp.EncodeToBytes(b)
		line("b %x %v", eb, err)
		z := new(uint256.Int).SetUint64(r.Uint64())
		ez, _ := rlp.EncodeToBytes(z)
		line("z %x", ez)
		raw := make([]byte, r.IntN(12))
		for j := range raw {
			raw[j] = byte(r.Uint32())
		}
		var s string
		var bs []byte
		var bi big.Int
		var ui uint256.Int
		var bl bool
		var ar [4]byte
		var any []interface{}
		line("dec %x %v %v %v %v %v %v %v %v", raw, rlp.DecodeBytes(raw, &s), rlp.DecodeBytes(raw, &bs), rlp.DecodeBytes(raw, &bi), rlp.DecodeBytes(raw, &ui), rlp.DecodeBytes(raw, &bl), rlp.DecodeBytes(raw, &ar), rlp.DecodeBytes(raw, &any), rlp.DecodeBytes(raw, &du))
		line("decv %q %x %s %s %v %x %v", s, bs, bi.String(), ui.Hex(), bl, ar, any)
	}
	fmt.Printf("%x\n", h.Sum(nil))
}
