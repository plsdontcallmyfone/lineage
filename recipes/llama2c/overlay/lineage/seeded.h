// Seeded inputs for the lineage harnesses (overlay, protected): FNV-1a of "<seed>/<salt>" feeds
// splitmix64, so inputs depend only on $LINEAGE_SEED.
#pragma once
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { uint64_t s; } Rng;

static Rng rng_new(const char* seed, const char* salt) {
    uint64_t h = 1469598103934665603ULL;
    for (const unsigned char* p = (const unsigned char*)seed; *p; p++) { h ^= *p; h *= 1099511628211ULL; }
    h ^= '/'; h *= 1099511628211ULL;
    for (const unsigned char* p = (const unsigned char*)salt; *p; p++) { h ^= *p; h *= 1099511628211ULL; }
    Rng r = { h };
    return r;
}

static uint64_t rng_next(Rng* r) {
    uint64_t z = (r->s += 0x9e3779b97f4a7c15ULL);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
    return z ^ (z >> 31);
}

static uint32_t rng_below(Rng* r, uint32_t n) { return (uint32_t)(rng_next(r) % n); }

// uniform in [-a, a), exactly representable steps so every platform builds the same floats
static float rng_float(Rng* r, float a) { return ((float)((int32_t)(rng_next(r) >> 40) - 8388608) / 8388608.0f) * a; }

// English-like text with punctuation, digits, newlines and some multi-byte UTF-8 (2, 3 and 4
// byte sequences, including codepoints the vocabulary lacks, so byte fallback runs).
static const char* const WORDS[] = {
    "the", "of", "and", "to", "in", "is", "was", "that", "for", "on", "with", "as", "it", "his",
    "they", "at", "be", "this", "from", "have", "one", "had", "by", "word", "but", "not", "what",
    "all", "were", "we", "when", "your", "can", "said", "there", "use", "an", "each", "which",
    "she", "do", "how", "their", "if", "will", "up", "other", "about", "out", "many", "then",
    "them", "these", "so", "some", "her", "would", "make", "like", "him", "into", "time", "has",
    "look", "two", "more", "write", "go", "see", "number", "no", "way", "could", "people", "my",
    "than", "first", "water", "been", "call", "who", "oil", "its", "now", "find", "long", "down",
    "day", "did", "get", "come", "made", "may", "part", "Lily", "Tim", "happy", "park", "ball",
    "dog", "little", "friend", "played", "big", "tree", "Once", "upon", "decided", "smiled",
    "transformer", "tokenizer", "attention", "gradient", "embedding", "blockchain", "Bitcoin",
    "caf\xc3\xa9", "na\xc3\xafve", "\xc3\xbc" "ber", "se\xc3\xb1or", "\xe4\xb8\xad\xe6\x96\x87",
    "\xe2\x82\xac", "\xf0\x9f\x98\x80", "\xf0\x9f\x9a\x80", "\xd0\xbf\xd1\x80\xd0\xb8\xd0\xb2\xd0\xb5\xd1\x82",
    "2024", "42", "3.14", "(x)", "[1]", "#tag", "e-mail", "don't", "it's", "--", "...",
};
#define NWORDS ((int)(sizeof(WORDS) / sizeof(WORDS[0])))

// writes a seeded text of about `len` bytes into buf (capacity len + 64)
static void rng_text(Rng* r, char* buf, int len) {
    int n = 0;
    buf[0] = '\0';
    while (n < len) {
        const char* w = WORDS[rng_below(r, NWORDS)];
        int wl = (int)strlen(w);
        if (n) {
            uint32_t k = rng_below(r, 40);
            const char* sep = k == 0 ? ", " : k == 1 ? ". " : k == 2 ? "\n" : k == 3 ? "  " : k == 4 ? "! " : " ";
            int sl = (int)strlen(sep);
            memcpy(buf + n, sep, sl);
            n += sl;
        }
        memcpy(buf + n, w, wl);
        n += wl;
        buf[n] = '\0';
    }
}
