// lineage_bench for go-ethereum/rlp (overlay, protected). Usage: rlpbench <encode|decode|stream> <seed>
// Run under callgrind with GOMAXPROCS=1 GOGC=off GODEBUG=asyncpreemptoff=1. Inputs depend only on the seed.
package main

import (
	"bytes"
	"fmt"
	"os"

	"github.com/ethereum/go-ethereum/lineage/internal/gen"
	"github.com/ethereum/go-ethereum/rlp"
)

const blocks = 60
const txsPerBlock = 40

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: rlpbench <encode|decode|stream> <seed>")
		os.Exit(2)
	}
	mode, seed := os.Args[1], os.Args[2]
	r := gen.Rng(seed, "bench")
	in := make([]gen.Block, blocks)
	for i := range in {
		in[i] = gen.NewBlock(r, txsPerBlock)
	}
	var enc [][]byte
	if mode == "decode" {
		for i := range in {
			b, err := rlp.EncodeToBytes(&in[i])
			must(err)
			enc = append(enc, b)
		}
	}
	// Pin the goroutine to its P for the measured region (m.locks > 0): sysmon still flags a
	// goroutine that has run for 10 ms of wall time, but the runtime then declines to
	// preempt it, instead of entering the scheduler a wall-clock-dependent number of times
	// (~900 instructions each under valgrind). Nothing in run blocks, so this is safe.
	growStack(16) // grow the goroutine stack before the measured region (see growStack)
	procPin()
	sum := run(mode, in, enc)
	procUnpin()
	fmt.Println(sum)
}

// run is the measured region: the recipe's metric collects instructions only inside it
// (callgrind --toggle-collect=main.run), so input generation and runtime start-up are excluded.
//
//go:noinline
func run(mode string, in []gen.Block, enc [][]byte) int {
	var sum int
	switch mode {
	case "encode":
		for round := 0; round < 3; round++ {
			for i := range in {
				b, err := rlp.EncodeToBytes(&in[i])
				must(err)
				sum += len(b)
			}
		}
	case "decode":
		for round := 0; round < 3; round++ {
			for i := range enc {
				var out gen.Block
				must(rlp.DecodeBytes(enc[i], &out))
				sum += len(out.Txs)
			}
		}
	case "stream":
		// raw value walking (Split, CountValues) and Stream-based decoding of every tx
		var buf bytes.Buffer
		for i := range in {
			must(rlp.Encode(&buf, in[i].Txs))
		}
		data := buf.Bytes()
		for round := 0; round < 3; round++ {
			rest := data
			for len(rest) > 0 {
				content, tail, err := rlp.SplitList(rest)
				must(err)
				n, err := rlp.CountValues(content)
				must(err)
				sum += n
				s := rlp.NewStream(bytes.NewReader(rest[:len(rest)-len(tail)]), 0)
				_, err = s.List()
				must(err)
				for j := 0; j < n; j++ {
					var tx gen.Tx
					must(s.Decode(&tx))
				}
				must(s.ListEnd())
				rest = tail
			}
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown mode", mode)
		os.Exit(2)
	}
	return sum
}

// growStack grows the goroutine stack to about 1 MiB before the measured region. Go grows a stack by
// copying it to a new one, a stack switch that callgrind on amd64 intermittently took for main.run
// returning, after which it stopped counting: encode_ir read about 0.68M in most runs and 43.6M in
// others on one tree (decode and stream grow the stack before run and were stable). With GOGC=off the
// stack never shrinks back, so run never grows it again; 12 runs then agreed within 4.7e-5.
//
//go:noinline
func growStack(n int) byte {
	var b [64 << 10]byte
	b[n%len(b)] = byte(n)
	if n > 0 {
		return growStack(n-1) + b[0]
	}
	return b[1]
}
