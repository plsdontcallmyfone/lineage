// Package gen builds seeded RLP workloads for the lineage harnesses (overlay, protected).
// Inputs depend only on the seed string: sha256(seed) seeds a PCG generator.
package gen

import (
	"crypto/sha256"
	"encoding/binary"
	"math/big"
	"math/rand/v2"

	"github.com/holiman/uint256"
)

// Rng returns a deterministic generator for a seed string.
func Rng(seed, salt string) *rand.Rand {
	h := sha256.Sum256([]byte(seed + "/" + salt))
	return rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[0:8]), binary.LittleEndian.Uint64(h[8:16])))
}

// AccessTuple mirrors an EIP-2930 access list entry.
type AccessTuple struct {
	Address     [20]byte
	StorageKeys [][32]byte
}

// Tx is shaped like an EIP-1559 transaction: integers of every width, big and 256-bit
// integers, an optional pointer, byte strings of all sizes and nested lists.
type Tx struct {
	ChainID    *big.Int
	Nonce      uint64
	GasTipCap  *uint256.Int
	GasFeeCap  *uint256.Int
	Gas        uint64
	To         *[20]byte `rlp:"nil"`
	Value      *big.Int
	Data       []byte
	AccessList []AccessTuple
	V, R, S    *big.Int
}

// Header is shaped like a block header, with an optional trailing field.
type Header struct {
	ParentHash  [32]byte
	Coinbase    [20]byte
	Root        [32]byte
	Bloom       [256]byte
	Difficulty  *big.Int
	Number      *big.Int
	GasLimit    uint64
	GasUsed     uint64
	Time        uint64
	Extra       []byte
	BaseFee     *big.Int `rlp:"optional"`
	Withdrawals []uint64 `rlp:"optional"`
}

// Block bundles a header with transactions and raw uncles.
type Block struct {
	Header Header
	Txs    []Tx
	Names  []string
	Flags  []bool
	Small  []uint16
}

func bytesN(r *rand.Rand, n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(r.Uint32())
	}
	return b
}

// size picks lengths around every RLP header boundary (0, 1, 55, 56, 255, 256, ...).
func size(r *rand.Rand) int {
	switch r.IntN(8) {
	case 0:
		return 0
	case 1:
		return 1
	case 2:
		return 54 + r.IntN(4)
	case 3:
		return 250 + r.IntN(10)
	case 4:
		return 1000 + r.IntN(4000)
	default:
		return r.IntN(120)
	}
}

func bigInt(r *rand.Rand) *big.Int {
	return new(big.Int).SetBytes(bytesN(r, r.IntN(33)))
}

func u256(r *rand.Rand) *uint256.Int {
	z := new(uint256.Int)
	z.SetBytes(bytesN(r, r.IntN(33)))
	return z
}

func u64(r *rand.Rand) uint64 {
	return r.Uint64() >> uint(r.IntN(64))
}

func NewTx(r *rand.Rand) Tx {
	tx := Tx{
		ChainID:   big.NewInt(int64(r.IntN(100000))),
		Nonce:     u64(r),
		GasTipCap: u256(r),
		GasFeeCap: u256(r),
		Gas:       u64(r),
		Value:     bigInt(r),
		Data:      bytesN(r, size(r)),
		V:         big.NewInt(int64(r.IntN(2))),
		R:         new(big.Int).SetBytes(bytesN(r, 32)),
		S:         new(big.Int).SetBytes(bytesN(r, 32)),
	}
	if r.IntN(5) != 0 {
		var to [20]byte
		copy(to[:], bytesN(r, 20))
		tx.To = &to
	}
	for range r.IntN(4) {
		var t AccessTuple
		copy(t.Address[:], bytesN(r, 20))
		for range r.IntN(5) {
			var k [32]byte
			copy(k[:], bytesN(r, 32))
			t.StorageKeys = append(t.StorageKeys, k)
		}
		tx.AccessList = append(tx.AccessList, t)
	}
	return tx
}

func NewBlock(r *rand.Rand, ntx int) Block {
	var b Block
	h := &b.Header
	copy(h.ParentHash[:], bytesN(r, 32))
	copy(h.Coinbase[:], bytesN(r, 20))
	copy(h.Root[:], bytesN(r, 32))
	copy(h.Bloom[:], bytesN(r, 256))
	h.Difficulty = bigInt(r)
	h.Number = big.NewInt(int64(r.IntN(30000000)))
	h.GasLimit, h.GasUsed, h.Time = u64(r), u64(r), u64(r)
	h.Extra = bytesN(r, r.IntN(33))
	if r.IntN(2) == 0 {
		h.BaseFee = bigInt(r)
		if r.IntN(2) == 0 {
			for range r.IntN(6) {
				h.Withdrawals = append(h.Withdrawals, u64(r))
			}
		}
	}
	for range ntx {
		b.Txs = append(b.Txs, NewTx(r))
	}
	for range r.IntN(8) {
		b.Names = append(b.Names, string(bytesN(r, size(r)%80)))
	}
	for range r.IntN(8) {
		b.Flags = append(b.Flags, r.IntN(2) == 0)
	}
	for range r.IntN(16) {
		b.Small = append(b.Small, uint16(r.Uint32()))
	}
	return b
}
