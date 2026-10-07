// Seeded inputs for the lineage harnesses (overlay, protected): FNV-1a of the seed string feeds
// splitmix64, so inputs depend only on $LINEAGE_SEED.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

struct Rng {
    uint64_t s;
    explicit Rng(const std::string& seed, const char* salt)
    {
        uint64_t h = 1469598103934665603ULL;
        for (unsigned char c : seed + "/" + salt) { h ^= c; h *= 1099511628211ULL; }
        s = h;
    }
    uint64_t next()
    {
        uint64_t z = (s += 0x9e3779b97f4a7c15ULL);
        z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ULL;
        z = (z ^ (z >> 27)) * 0x94d049bb133111ebULL;
        return z ^ (z >> 31);
    }
    uint32_t below(uint32_t n) { return uint32_t(next() % n); }
    std::vector<unsigned char> bytes(size_t n)
    {
        std::vector<unsigned char> v(n);
        for (auto& b : v) b = (unsigned char)next();
        return v;
    }
    // Payload sizes seen in practice: 21 (P2PKH/P2SH version + hash160), 34 (WIF compressed),
    // 78 (BIP32 extended keys), plus leading zero bytes and a spread of other lengths.
    std::vector<unsigned char> payload()
    {
        static const size_t sizes[] = {21, 21, 21, 33, 34, 78, 78, 1, 8, 32, 64, 100};
        auto v = bytes(sizes[below(12)]);
        size_t z = below(4) == 0 ? below(4) : 0;
        for (size_t i = 0; i < z && i < v.size(); ++i) v[i] = 0;
        return v;
    }
};
