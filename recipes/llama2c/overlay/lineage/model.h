// Seeded random checkpoint for the lineage harnesses (overlay, protected). Writes a llama2.c
// version-0 checkpoint (Config header, then weights in memory_map_weights order) to `path`.
// The shape is small but exercises every code path of forward(): several layers, grouped-query
// attention (n_kv_heads < n_heads), a hidden size that is not a multiple of dim, and shared or
// separate classifier weights.
#pragma once
#include "seeded.h"

typedef struct { int dim, hidden_dim, n_layers, n_heads, n_kv_heads, vocab_size, seq_len; } LineageShape;

static void lineage_write_model(const char* path, Rng* r, LineageShape s, int shared) {
    FILE* f = fopen(path, "wb");
    if (!f) { fprintf(stderr, "cannot write %s\n", path); exit(1); }
    int hdr[7] = { s.dim, s.hidden_dim, s.n_layers, s.n_heads, s.n_kv_heads, shared ? s.vocab_size : -s.vocab_size, s.seq_len };
    fwrite(hdr, sizeof(int), 7, f);
    int head = s.dim / s.n_heads, kv = s.n_kv_heads * head;
    long L = s.n_layers;
    // name, count, scale (0 means rmsnorm weights around 1)
    struct { long n; float a; } parts[] = {
        { (long)s.vocab_size * s.dim, 0.5f },
        { L * s.dim, 0 },
        { L * s.dim * s.dim, 0.35f },
        { L * s.dim * kv, 0.35f },
        { L * s.dim * kv, 0.35f },
        { L * s.dim * s.dim, 0.35f },
        { L * s.dim, 0 },
        { L * s.dim * s.hidden_dim, 0.3f },
        { L * s.hidden_dim * s.dim, 0.3f },
        { L * s.dim * s.hidden_dim, 0.3f },
        { s.dim, 0 },
        { (long)s.seq_len * head, 0.0f },  // legacy freq_cis_real + freq_cis_imag, unused
        { shared ? 0 : (long)s.vocab_size * s.dim, 0.5f },
    };
    for (unsigned p = 0; p < sizeof(parts) / sizeof(parts[0]); p++) {
        for (long i = 0; i < parts[p].n; i++) {
            float v = parts[p].a == 0 ? 1.0f + rng_float(r, 0.25f) : rng_float(r, parts[p].a);
            if (p == 11) v = 0;
            fwrite(&v, sizeof(float), 1, f);
        }
    }
    fclose(f);
}
