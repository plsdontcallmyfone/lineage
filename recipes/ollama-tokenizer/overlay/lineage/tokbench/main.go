// lineage_bench for ollama's mlxrunner/tokenizer (overlay, protected).
// Usage: tokbench <encode|decode> <seed>. Run under callgrind with --toggle-collect=main.run,
// GOMAXPROCS=1 GOGC=off GODEBUG=asyncpreemptoff=1,memprofilerate=0. Loading the 128K-entry
// vocabulary and building the inputs happen outside run and are not counted.
package main

import (
	"fmt"
	"os"

	"github.com/ollama/ollama/lineage/internal/llama"
	"github.com/ollama/ollama/mlxrunner/tokenizer"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: tokbench <encode|decode> <seed>")
		os.Exit(2)
	}
	mode, seed := os.Args[1], os.Args[2]
	tok := llama.Load()
	texts := llama.Texts(llama.Rng(seed, "bench"), llama.Corpus(), 300, 1200)
	var ids [][]int32
	if mode == "decode" {
		for _, s := range texts {
			ids = append(ids, tok.Encode(s, true))
		}
	} else if mode != "encode" {
		fmt.Fprintln(os.Stderr, "unknown mode", mode)
		os.Exit(2)
	}
	// Pin the goroutine to its P for the measured region (see geth-rlp's harness): the
	// runtime then declines sysmon's wall-clock preemption requests instead of entering the
	// scheduler a varying number of times. Nothing in run blocks.
	procPin()
	sum := run(mode, tok, texts, ids)
	procUnpin()
	fmt.Println(sum)
}

// run is the measured region (callgrind --toggle-collect=main.run).
//
//go:noinline
func run(mode string, tok *tokenizer.Tokenizer, texts []string, ids [][]int32) int {
	sum := 0
	switch mode {
	case "encode":
		for _, s := range texts {
			sum += len(tok.Encode(s, true))
		}
	case "decode":
		for round := 0; round < 4; round++ {
			for _, x := range ids {
				sum += len(tok.Decode(x))
			}
		}
	}
	return sum
}
