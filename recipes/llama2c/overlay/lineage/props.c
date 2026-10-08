// Property tests for karpathy/llama2.c's tokenizer (overlay, protected). Usage: props <first-number>
// Prints TAP lines numbered from <first-number> and the plan for the whole run (the runner prints
// test 1, upstream's test.c). Each test compares run.c's encode()/decode() with a verbatim copy of
// the snapshot's tokenizer (ref_tokenizer.h) on fixed-seed inputs, so tests are deterministic.
#define TESTING
#include "../run.c"
#include "ref_tokenizer.h"
#include "seeded.h"

static Tokenizer tok;
static RefTokenizer ref;
static int tokens[4096], rtokens[4096];

static int same_encoding(const char* text, int bos, int eos) {
    int n = 0, rn = 0;
    encode(&tok, (char*)text, (int8_t)bos, (int8_t)eos, tokens, &n);
    ref_encode(&ref, (char*)text, (int8_t)bos, (int8_t)eos, rtokens, &rn);
    if (n != rn) return 0;
    for (int i = 0; i < n; i++) if (tokens[i] != rtokens[i]) return 0;
    return 1;
}

static int t_seeded(const char* salt, int bos, int eos, int maxlen) {
    Rng r = rng_new("props", salt);
    char text[1024 + 64];
    for (int k = 0; k < 25; k++) {
        rng_text(&r, text, 1 + (int)rng_below(&r, (uint32_t)maxlen));
        if (!same_encoding(text, bos, eos)) { printf("# mismatch on text %d\n", k); return 0; }
    }
    return 1;
}

static int t_edge(void) {
    const char* edge[] = { "", " ", "  ", "\n\n", "a", "I", " leading space", "trailing space ",
                           "<0x41>", "<s></s>", "\t", "UPPER CASE WORDS", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    for (unsigned e = 0; e < sizeof(edge) / sizeof(edge[0]); e++)
        for (int be = 0; be < 4; be++)
            if (!same_encoding(edge[e], be & 1, be >> 1)) { printf("# mismatch on edge %u/%d\n", e, be); return 0; }
    return 1;
}

static int t_utf8(void) {
    const char* u[] = { "caf\xc3\xa9", "\xe4\xb8\xad\xe6\x96\x87\xe5\xad\x97", "\xf0\x9f\x98\x80\xf0\x9f\x98\x81",
                        "\xf0\x90\x8d\x88", "\xe2\x82\xac 5", "\xd0\x9f\xd1\x80\xd0\xb8", "\xea\xb0\x80\xeb\x82\x98" };
    for (unsigned e = 0; e < sizeof(u) / sizeof(u[0]); e++)
        if (!same_encoding(u[e], 1, 0)) { printf("# mismatch on utf8 %u\n", e); return 0; }
    return 1;
}

static int t_invalid_utf8(void) {
    const char* u[] = { "\x80", "\xc3", "a\xc3", "\xe4\xb8", "\xff", "\x80\x80\x80\x80\x80", "\xf0\x9f\x98\x80\x80\x80", "x\xc0\xafy" };
    for (unsigned e = 0; e < sizeof(u) / sizeof(u[0]); e++)
        if (!same_encoding(u[e], 1, 1)) { printf("# mismatch on invalid utf8 %u\n", e); return 0; }
    return 1;
}

static int t_decode(void) {
    int prevs[] = { 0, 1, 2, 5, 29871 };
    for (unsigned p = 0; p < sizeof(prevs) / sizeof(prevs[0]); p++)
        for (int id = 0; id < 32000; id++)
            if (strcmp(decode(&tok, prevs[p], id), ref_decode(&ref, prevs[p], id)) != 0) { printf("# decode mismatch %d %d\n", prevs[p], id); return 0; }
    return 1;
}

// decoding the encoding of valid UTF-8 text gives the text back (BOS strips the dummy prefix)
static int t_roundtrip(void) {
    Rng r = rng_new("props", "roundtrip");
    char text[512 + 64], back[4096];
    for (int k = 0; k < 20; k++) {
        rng_text(&r, text, 1 + (int)rng_below(&r, 300));
        int n = 0;
        encode(&tok, text, 1, 0, tokens, &n);
        back[0] = '\0';
        size_t bl = 0;
        for (int i = 1; i < n; i++) {
            const char* piece = decode(&tok, tokens[i - 1], tokens[i]);
            size_t pl = strlen(piece);
            if (bl + pl >= sizeof(back)) return 0;
            memcpy(back + bl, piece, pl + 1);
            bl += pl;
        }
        if (strcmp(back, text) != 0) { printf("# roundtrip mismatch on text %d\n", k); return 0; }
    }
    return 1;
}

int main(int argc, char** argv) {
    int first = argc > 1 ? atoi(argv[1]) : 1;
    build_tokenizer(&tok, "tokenizer.bin", 32000);
    ref_build_tokenizer(&ref, "tokenizer.bin", 32000);
    struct { const char* name; int (*fn)(void); } tests[] = {
        { "props::encode_matches_reference_bos", NULL },
        { "props::encode_matches_reference_eos", NULL },
        { "props::encode_matches_reference_long", NULL },
        { "props::encode_edge_cases", t_edge },
        { "props::encode_utf8", t_utf8 },
        { "props::encode_invalid_utf8", t_invalid_utf8 },
        { "props::decode_matches_reference", t_decode },
        { "props::decode_encode_roundtrip", t_roundtrip },
    };
    int n = (int)(sizeof(tests) / sizeof(tests[0])), bad = 0;
    for (int i = 0; i < n; i++) {
        int ok = i == 0 ? t_seeded("bos", 1, 0, 200) : i == 1 ? t_seeded("eos", 0, 1, 200) : i == 2 ? t_seeded("long", 1, 1, 900) : tests[i].fn();
        if (!ok) bad++;
        printf("%s %d - %s\n", ok ? "ok" : "not ok", first + i, tests[i].name);
        fflush(stdout);
    }
    printf("1..%d\n", first + n - 1);
    free_tokenizer(&tok);
    ref_free_tokenizer(&ref);
    return bad ? 1 : 0;
}
