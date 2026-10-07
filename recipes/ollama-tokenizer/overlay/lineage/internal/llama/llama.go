// Package llama loads the Llama 3.2 byte-level BPE tokenizer from the fixture upstream ships
// (mlxrunner/tokenizer/testdata/llama3.2: encoder.json + vocab.bpe), assembled into a
// tokenizer.json exactly the way upstream's TestGGMLLlamaKnownEncodings fixture loader does,
// and builds seeded text from the repository's own docs. Overlay, protected.
package llama

import (
	"bufio"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"math/rand/v2"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ollama/ollama/mlxrunner/tokenizer"
)

const fixture = "mlxrunner/tokenizer/testdata/llama3.2"

type addedToken struct {
	ID      int32  `json:"id"`
	Content string `json:"content"`
	Special bool   `json:"special"`
}

type pretok struct {
	Type    string `json:"type"`
	Pattern struct {
		Regex string `json:"Regex"`
	} `json:"pattern"`
}

// Load returns the tokenizer, or exits the process on any error.
func Load() *tokenizer.Tokenizer {
	raw, err := os.ReadFile(filepath.Join(fixture, "encoder.json"))
	check(err)
	vocab := make(map[string]int32)
	check(json.Unmarshal(raw, &vocab))
	var added []addedToken
	for _, tok := range []string{"<|begin_of_text|>", "<|end_of_text|>"} {
		if _, ok := vocab[tok]; !ok {
			id := int32(len(vocab))
			vocab[tok] = id
			added = append(added, addedToken{ID: id, Content: tok, Special: true})
		}
	}
	f, err := os.Open(filepath.Join(fixture, "vocab.bpe"))
	check(err)
	defer f.Close()
	var merges []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "#") {
			continue
		}
		if line = strings.TrimSpace(line); line != "" {
			merges = append(merges, line)
		}
	}
	check(sc.Err())
	var payload struct {
		Model struct {
			Type   string           `json:"type"`
			Vocab  map[string]int32 `json:"vocab"`
			Merges []string         `json:"merges"`
		} `json:"model"`
		PreTokenizer struct {
			Type          string   `json:"type"`
			Pretokenizers []pretok `json:"pretokenizers"`
		} `json:"pre_tokenizer"`
		AddedTokens []addedToken `json:"added_tokens"`
	}
	payload.Model.Type = "BPE"
	payload.Model.Vocab = vocab
	payload.Model.Merges = merges
	payload.PreTokenizer.Type = "Sequence"
	p := pretok{Type: "Split"}
	p.Pattern.Regex = `(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+`
	payload.PreTokenizer.Pretokenizers = []pretok{p}
	payload.AddedTokens = added
	data, err := json.Marshal(payload)
	check(err)
	tok, err := tokenizer.LoadFromBytes(data)
	check(err)
	return tok
}

// Corpus is the concatenation of the repository's Markdown docs, in sorted path order.
func Corpus() string {
	var files []string
	check(filepath.Walk("docs", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && (strings.HasSuffix(path, ".md") || strings.HasSuffix(path, ".mdx")) {
			files = append(files, path)
		}
		return nil
	}))
	sort.Strings(files)
	var b strings.Builder
	for _, f := range files {
		d, err := os.ReadFile(f)
		check(err)
		b.Write(d)
		b.WriteByte('\n')
	}
	return b.String()
}

// Rng returns a deterministic generator for a seed string.
func Rng(seed, salt string) *rand.Rand {
	h := sha256.Sum256([]byte(seed + "/" + salt))
	return rand.New(rand.NewPCG(binary.LittleEndian.Uint64(h[0:8]), binary.LittleEndian.Uint64(h[8:16])))
}

var extras = []string{"<|begin_of_text|>", "<|end_of_text|>", "こんにちは世界", "请考试我的软件！12345", "naïve café ", "\t\t", "\r\n", "   ", "1234567890", "don't we'll they're", "🙂🚀", "Ünïcödé"}

// Texts cuts n seeded windows (up to maxLen bytes, on rune boundaries) out of the corpus and
// splices in special tokens, CJK, emoji, digits and whitespace runs.
func Texts(r *rand.Rand, corpus string, n, maxLen int) []string {
	out := make([]string, 0, n)
	for range n {
		start := r.IntN(len(corpus) - maxLen)
		for start > 0 && corpus[start]&0xC0 == 0x80 {
			start--
		}
		end := start + 1 + r.IntN(maxLen)
		for end < len(corpus) && corpus[end]&0xC0 == 0x80 {
			end++
		}
		s := corpus[start:end]
		if r.IntN(3) == 0 {
			at := r.IntN(len(s) + 1)
			for at < len(s) && s[at]&0xC0 == 0x80 {
				at++
			}
			s = s[:at] + extras[r.IntN(len(extras))] + s[at:]
		}
		out = append(out, s)
	}
	return out
}

func check(err error) {
	if err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}
