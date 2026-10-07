// lineage_equiv for bitcoin/bitcoin's Base58 (overlay, protected). Usage: equiv <seed>
// Prints encodings, decodings and accept/reject decisions (with max_ret_len limits, whitespace,
// invalid characters and corrupted checksums) for seeded inputs; the digest of stdout is compared.
#include "seeded.h"

#include <base58.h>

#include <cstdio>
#include <string>
#include <vector>

static std::string hex(const std::vector<unsigned char>& v)
{
    static const char* d = "0123456789abcdef";
    std::string s;
    for (unsigned char c : v) { s += d[c >> 4]; s += d[c & 15]; }
    return s;
}

int main(int argc, char** argv)
{
    if (argc != 2) { std::fprintf(stderr, "usage: equiv <seed>\n"); return 2; }
    Rng rng(argv[1], "equiv");
    static const char ws[] = " \t\n\v\f\r";
    static const char alpha[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0OIl+/ ";
    for (int i = 0; i < 3000; ++i) {
        auto v = rng.below(5) == 0 ? rng.bytes(rng.below(300)) : rng.payload();
        if (rng.below(6) == 0) for (size_t k = 0, z = rng.below(6); k < z && k < v.size(); ++k) v[k] = 0;
        std::string e = EncodeBase58(v), c = EncodeBase58Check(v);
        std::vector<unsigned char> out;
        int lim = rng.below(3) == 0 ? (int)rng.below((unsigned)v.size() + 6) : 512;
        bool ok = DecodeBase58(e, out, lim);
        std::printf("e %s %s %d %d %s\n", hex(v).c_str(), e.c_str(), lim, ok, ok ? hex(out).c_str() : "");
        ok = DecodeBase58Check(c, out, lim);
        std::printf("c %s %d %s\n", c.c_str(), ok, ok ? hex(out).c_str() : "");
        // whitespace padding, a corrupted character, a random string
        std::string p = std::string(rng.below(3), ws[rng.below(6)]) + e + std::string(rng.below(3), ws[rng.below(6)]);
        ok = DecodeBase58(p, out, 512);
        std::printf("p %d %s\n", ok, ok ? hex(out).c_str() : "");
        if (!c.empty()) {
            std::string m = c;
            m[rng.below((unsigned)m.size())] = alpha[rng.below(sizeof(alpha) - 1)];
            ok = DecodeBase58Check(m, out, 512);
            std::printf("m %s %d %s\n", m.c_str(), ok, ok ? hex(out).c_str() : "");
        }
        std::string r;
        for (size_t k = 0, n = rng.below(40); k < n; ++k) r += alpha[rng.below(sizeof(alpha) - 1)];
        ok = DecodeBase58(r, out, (int)rng.below(40));
        std::printf("r %s %d %s\n", r.c_str(), ok, ok ? hex(out).c_str() : "");
    }
    return 0;
}
