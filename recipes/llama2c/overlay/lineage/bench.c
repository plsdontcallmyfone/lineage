// lineage_bench for karpathy/llama2.c (overlay, protected). Usage: bench <encode|forward> <seed>
// Measured under cachegrind (whole process). Inputs depend only on the seed.
//   encode:  BPE-encodes seeded English-like text (with multi-byte UTF-8) using the repository's
//            Llama 2 tokenizer.bin (32000 tokens).
//   forward: runs forward() over 48 positions of a seeded random checkpoint (written to /tmp),
//            feeding seeded prompt tokens and then greedy argmax samples back in.
#define TESTING
#include "../run.c"
#include "seeded.h"
#include "model.h"

static int bench_encode(const char* seed) {
    Tokenizer tok;
    build_tokenizer(&tok, "tokenizer.bin", 32000);
    Rng r = rng_new(seed, "encode");
    char text[512 + 64];
    int* tokens = malloc((sizeof(text) + 3) * sizeof(int));
    unsigned sum = 0;
    for (int k = 0; k < 24; k++) {
        rng_text(&r, text, 60 + (int)rng_below(&r, 200));
        int n = 0;
        encode(&tok, text, 1, k & 1, tokens, &n);
        for (int i = 0; i < n; i++) sum = sum * 31 + (unsigned)tokens[i];
    }
    free(tokens);
    free_tokenizer(&tok);
    printf("encode %08x\n", sum);
    return 0;
}

static int bench_forward(const char* seed) {
    Rng r = rng_new(seed, "forward");
    LineageShape s = { 64, 176, 3, 8, 4, 384, 64 };
    char path[64];
    snprintf(path, sizeof(path), "/tmp/lineage-model-%d.bin", (int)getpid());
    lineage_write_model(path, &r, s, (int)rng_below(&r, 2));
    Transformer t;
    build_transformer(&t, path);
    unlink(path);
    int token = 1;
    unsigned sum = 0;
    for (int pos = 0; pos < 48; pos++) {
        float* logits = forward(&t, token, pos);
        int next = sample_argmax(logits, s.vocab_size);
        sum = sum * 31 + (unsigned)next;
        token = pos < 16 ? 3 + (int)rng_below(&r, (uint32_t)s.vocab_size - 3) : next;
    }
    free_transformer(&t);
    printf("forward %08x\n", sum);
    return 0;
}

int main(int argc, char** argv) {
    if (argc != 3) { fprintf(stderr, "usage: bench <encode|forward> <seed>\n"); return 2; }
    if (!strcmp(argv[1], "encode")) return bench_encode(argv[2]);
    if (!strcmp(argv[1], "forward")) return bench_forward(argv[2]);
    fprintf(stderr, "unknown mode %s\n", argv[1]);
    return 2;
}
