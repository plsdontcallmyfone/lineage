// lineage_equiv for ollama's mlxrunner/tokenizer (overlay, protected). Usage: tokequiv <seed>
// Prints a digest over token ids and decoded strings for seeded texts (docs windows with special
// tokens, CJK, emoji and whitespace runs spliced in) and seeded random byte strings.
package main

import (
	"crypto/sha256"
	"fmt"
	"os"

	"github.com/ollama/ollama/lineage/internal/llama"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: tokequiv <seed>")
		os.Exit(2)
	}
	tok := llama.Load()
	r := llama.Rng(os.Args[1], "equiv")
	h := sha256.New()
	texts := llama.Texts(r, llama.Corpus(), 400, 2000)
	for i := 0; i < 300; i++ {
		b := make([]byte, r.IntN(64))
		for j := range b {
			b[j] = byte(r.Uint32())
		}
		texts = append(texts, string(b))
	}
	for i, s := range texts {
		ids := tok.Encode(s, i%2 == 0)
		fmt.Fprintf(h, "%d %v %q\n", i, ids, tok.Decode(ids))
	}
	fmt.Printf("%x\n", h.Sum(nil))
}
