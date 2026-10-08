// lineage_equiv for cosmos/go-bip39 (overlay, protected). Usage: bip39equiv <seed>
// Prints the observable result (value or error text) of every exported function on seeded inputs
// and edge cases: every entropy size, leading zero bytes, invalid sizes, swapped, unknown and
// missing words, extra spaces, wrong word counts, seeds with and without checks.
package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math/rand/v2"
	"os"
	"strings"

	bip39 "github.com/cosmos/go-bip39"
)

func show(label string, b []byte, err error) {
	if err != nil {
		fmt.Printf("%s err %q\n", label, err.Error())
		return
	}
	fmt.Printf("%s ok %s\n", label, hex.EncodeToString(b))
}

func showS(label string, s string, err error) {
	if err != nil {
		fmt.Printf("%s err %q\n", label, err.Error())
		return
	}
	fmt.Printf("%s ok %q\n", label, s)
}

func main() {
	h := sha256.Sum256([]byte(os.Args[1] + "/equiv"))
	r := rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[0:8]), binary.LittleEndian.Uint64(h[8:16])))
	randBytes := func(n int) []byte {
		b := make([]byte, n)
		for i := range b {
			b[i] = byte(r.Uint32())
		}
		return b
	}
	for _, n := range []int{0, 1, 4, 12, 15, 16, 17, 20, 24, 28, 31, 32, 33, 36, 64} {
		_, err := bip39.NewEntropy(n * 8)
		fmt.Printf("newentropy %d %v\n", n*8, err)
		p, err := bip39.NewMnemonic(make([]byte, n))
		showS(fmt.Sprintf("zero %d", n), p, err)
		p, err = bip39.NewMnemonic(bytesOf(n, 0xff))
		showS(fmt.Sprintf("ff %d", n), p, err)
	}
	sizes := []int{16, 20, 24, 28, 32}
	for i := 0; i < 300; i++ {
		e := randBytes(sizes[r.IntN(len(sizes))])
		for z := r.IntN(5); z > 0 && z <= len(e); z-- {
			if r.IntN(3) == 0 {
				e[z-1] = 0
			}
		}
		p, err := bip39.NewMnemonic(e)
		showS(fmt.Sprintf("nm %d", i), p, err)
		b, err := bip39.MnemonicToByteArray(p)
		show(fmt.Sprintf("mb %d", i), b, err)
		fmt.Printf("valid %d %v\n", i, bip39.IsMnemonicValid(p))
		w := strings.Split(p, " ")
		w2 := append([]string(nil), w...)
		w2[r.IntN(len(w2))] = bip39.WordList[r.IntN(2048)]
		q := strings.Join(w2, " ")
		b, err = bip39.MnemonicToByteArray(q)
		show(fmt.Sprintf("swap %d", i), b, err)
		fmt.Printf("swapvalid %d %v\n", i, bip39.IsMnemonicValid(q))
		switch r.IntN(6) {
		case 0:
			q = strings.Join(w[:len(w)-1], " ")
		case 1:
			q = strings.Join(w, "  ")
		case 2:
			q = p + " " + w[0] + " " + w[1] + " " + w[2]
		case 3:
			w2[r.IntN(len(w2))] = "notaword"
			q = strings.Join(w2, " ")
		case 4:
			q = strings.ToUpper(p)
		default:
			q = " " + p + "\t"
		}
		b, err = bip39.MnemonicToByteArray(q)
		show(fmt.Sprintf("odd %d", i), b, err)
		fmt.Printf("oddvalid %d %v\n", i, bip39.IsMnemonicValid(q))
		if i%40 == 0 {
			s, err := bip39.NewSeedWithErrorChecking(p, "TREZOR")
			show(fmt.Sprintf("seed %d", i), s, err)
			s, err = bip39.NewSeedWithErrorChecking(q, "")
			show(fmt.Sprintf("seedodd %d", i), s, err)
			fmt.Printf("rawseed %d %x\n", i, bip39.NewSeed(q, "x"))
		}
	}
	for n := 0; n <= 27; n++ {
		ws := make([]string, n)
		for i := range ws {
			ws[i] = "abandon"
		}
		p := strings.Join(ws, " ")
		b, err := bip39.MnemonicToByteArray(p)
		show(fmt.Sprintf("abandon %d", n), b, err)
		fmt.Printf("abandonvalid %d %v\n", n, bip39.IsMnemonicValid(p))
	}
	fmt.Println("globals", bip39.Last11BitsMask, bip39.RightShift11BitsDivider, bip39.BigOne, bip39.BigTwo, len(bip39.WordList), len(bip39.ReverseWordMap))
}

func bytesOf(n int, v byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = v
	}
	return b
}
