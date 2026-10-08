// lineage_equiv for karpathy/llama2.c (overlay, protected). Usage: equiv <seed>
// Prints, for seeded inputs: encode() tokens for every bos/eos combination (including empty,
// whitespace-only, byte-fallback and invalid UTF-8 text), decode() of every vocabulary entry after
// several previous tokens, the exact bits of every logit forward() returns over 24 positions of two
// seeded random checkpoints (shared and separate classifier), and sample() / sample_topp() /
// sample_mult() picks for several temperatures, top-p values and coins. Float results are printed
// as raw bits, so a patch must keep forward() bit-identical.
#define TESTING
#include "../run.c"
#include "seeded.h"
#include "model.h"

static unsigned fbits(float f) { unsigned u; memcpy(&u, &f, 4); return u; }

int main(int argc, char** argv) {
    if (argc != 2) { fprintf(stderr, "usage: equiv <seed>\n"); return 2; }
    Rng r = rng_new(argv[1], "equiv");
    Tokenizer tok;
    build_tokenizer(&tok, "tokenizer.bin", 32000);
    printf("max_token_length %u\n", tok.max_token_length);
    int* tokens = malloc(4096 * sizeof(int));
    char text[1024 + 64];
    const char* edge[] = { "", " ", "  ", "\n", "a", "\xc3", "\x80\x80", "\xe4\xb8", "\xf0\x9f\x98\x80\x80\x80",
                           "\xff\xfe", "hello\x80world", "<0x0A>", "<s>", "</s>", "\t\t", "1234567890" };
    for (unsigned e = 0; e < sizeof(edge) / sizeof(edge[0]); e++)
        for (int be = 0; be < 4; be++) {
            int n = 0;
            encode(&tok, (char*)edge[e], be & 1, be >> 1, tokens, &n);
            printf("edge %u %d:", e, be);
            for (int i = 0; i < n; i++) printf(" %d", tokens[i]);
            printf("\n");
        }
    for (int k = 0; k < 40; k++) {
        rng_text(&r, text, 1 + (int)rng_below(&r, k < 30 ? 160 : 1000));
        if (k % 7 == 6) text[rng_below(&r, (uint32_t)strlen(text))] = (char)(0x80 + rng_below(&r, 0x80));
        int be = (int)rng_below(&r, 4), n = 0;
        encode(&tok, text, be & 1, be >> 1, tokens, &n);
        printf("text %d %d:", k, be);
        for (int i = 0; i < n; i++) printf(" %d", tokens[i]);
        printf("\n");
    }
    unsigned dsum = 0;
    int prevs[] = { 0, 1, 2, 3, 13, 29871 };
    for (unsigned p = 0; p < sizeof(prevs) / sizeof(prevs[0]); p++) {
        for (int id = 0; id < 32000; id++) {
            char* piece = decode(&tok, prevs[p], id);
            for (const unsigned char* c = (const unsigned char*)piece; ; c++) { dsum = dsum * 131 + *c; if (!*c) break; }
        }
        printf("decode prev %d %08x\n", prevs[p], dsum);
    }
    free_tokenizer(&tok);

    for (int m = 0; m < 2; m++) {
        LineageShape s = { 48, 136, 2, 6, m ? 2 : 6, 300, 32 };
        char path[64];
        snprintf(path, sizeof(path), "/tmp/lineage-equiv-%d-%d.bin", (int)getpid(), m);
        lineage_write_model(path, &r, s, m);
        Transformer t;
        build_transformer(&t, path);
        unlink(path);
        Sampler smp;
        float temps[] = { 0.0f, 1.0f, 0.7f, 1.3f };
        float topps[] = { 0.9f, 1.0f, 0.5f, 0.0f };
        int token = 1;
        for (int pos = 0; pos < 24; pos++) {
            float* logits = forward(&t, token, pos);
            printf("logits %d %d:", m, pos);
            for (int i = 0; i < s.vocab_size; i++) printf(" %08x", fbits(logits[i]));
            printf("\n");
            build_sampler(&smp, s.vocab_size, temps[pos % 4], topps[(pos / 4) % 4], 1234567ULL + (unsigned long long)pos);
            float* copy = malloc(s.vocab_size * sizeof(float));
            memcpy(copy, logits, s.vocab_size * sizeof(float));
            int next = sample(&smp, copy);
            printf("sample %d %d %d\n", m, pos, next);
            free(copy);
            free_sampler(&smp);
            token = next;
        }
        free_transformer(&t);
    }

    // samplers on seeded distributions, including ties and tiny tails
    ProbIndex* pi = malloc(1000 * sizeof(ProbIndex));
    float* probs = malloc(1000 * sizeof(float));
    for (int k = 0; k < 60; k++) {
        int n = 2 + (int)rng_below(&r, 998);
        float sum = 0;
        for (int i = 0; i < n; i++) {
            float v = rng_below(&r, 5) == 0 ? 0.0f : 1.0f + rng_float(&r, 0.99f);
            if (rng_below(&r, 9) == 0) v *= 50.0f;
            probs[i] = v;
            sum += v;
        }
        if (sum == 0) { probs[0] = 1; sum = 1; }
        for (int i = 0; i < n; i++) probs[i] /= sum;
        float coin = (float)rng_below(&r, 1 << 24) / 16777216.0f;
        float topp = (float)rng_below(&r, 100) / 100.0f;
        printf("samp %d %d %d %d", k, sample_argmax(probs, n), sample_mult(probs, n, coin), topp > 0 ? sample_topp(probs, n, topp, pi, coin) : -1);
        softmax(probs, n);
        printf(" %08x %08x\n", fbits(probs[0]), fbits(probs[n - 1]));
        float* xs = malloc(n * sizeof(float));
        float* ws = malloc(n * sizeof(float));
        float* o = malloc(n * sizeof(float));
        for (int i = 0; i < n; i++) { xs[i] = rng_float(&r, 3.0f); ws[i] = 1.0f + rng_float(&r, 0.5f); }
        rmsnorm(o, xs, ws, n);
        printf("rms %d %08x %08x\n", k, fbits(o[0]), fbits(o[n - 1]));
        int d = 1 + (int)rng_below(&r, 7), nn = n / d > 0 ? n / d : 1;
        matmul(o, xs, ws, nn, d);
        printf("mm %d", k);
        for (int i = 0; i < d; i++) printf(" %08x", fbits(o[i]));
        printf("\n");
        free(xs); free(ws); free(o);
    }
    free(pi); free(probs);
    printf("random %08x\n", ({ unsigned long long st = 42; unsigned acc = 0; for (int i = 0; i < 100; i++) acc = acc * 7 + random_u32(&st) + fbits(random_f32(&st)); acc; }));
    free(tokens);
    return 0;
}
