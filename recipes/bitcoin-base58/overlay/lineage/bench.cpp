// lineage_bench for bitcoin/bitcoin's Base58 (overlay, protected). Usage: bench <encode|decode|check> <seed>
// Run under cachegrind. Inputs depend only on the seed.
#include "seeded.h"

#include <base58.h>

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

int main(int argc, char** argv)
{
    if (argc != 3) { std::fprintf(stderr, "usage: bench <encode|decode|check> <seed>\n"); return 2; }
    std::string mode = argv[1];
    Rng rng(argv[2], "bench");
    const int N = 4000;
    std::vector<std::vector<unsigned char>> in;
    for (int i = 0; i < N; ++i) in.push_back(rng.payload());
    size_t sum = 0;
    if (mode == "encode") {
        for (auto& v : in) sum += EncodeBase58(v).size();
    } else if (mode == "decode") {
        std::vector<std::string> enc;
        for (auto& v : in) enc.push_back(EncodeBase58(v));
        std::vector<unsigned char> out;
        for (int r = 0; r < 2; ++r)
            for (auto& s : enc) { if (!DecodeBase58(s, out, 256)) return 1; sum += out.size(); }
    } else if (mode == "check") {
        std::vector<unsigned char> out;
        for (auto& v : in) {
            std::string s = EncodeBase58Check(v);
            if (!DecodeBase58Check(s, out, 256)) return 1;
            sum += out.size();
        }
    } else {
        std::fprintf(stderr, "unknown mode\n");
        return 2;
    }
    std::printf("%zu\n", sum);
    return 0;
}
