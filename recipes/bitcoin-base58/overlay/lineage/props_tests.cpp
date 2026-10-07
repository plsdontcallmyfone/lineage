// Lineage property tests for Base58 (overlay, protected), on top of upstream's base58_tests.cpp.
// They compare against an independent reference codec (schoolbook long division) on fixed-seed
// inputs and pin the documented edge cases: leading zeros, max_ret_len limits, whitespace,
// embedded NUL, invalid characters and checksum failures.
#include <boost/test/unit_test.hpp>

#include "seeded.h"

#include <base58.h>

#include <algorithm>
#include <string>
#include <vector>

namespace {
const char* ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

std::string RefEncode(std::vector<unsigned char> v)
{
    size_t zeros = 0;
    while (zeros < v.size() && v[zeros] == 0) ++zeros;
    std::string out;
    size_t start = zeros;
    while (start < v.size()) {
        unsigned rem = 0;
        for (size_t i = start; i < v.size(); ++i) {
            unsigned cur = rem * 256 + v[i];
            v[i] = (unsigned char)(cur / 58);
            rem = cur % 58;
        }
        out += ALPHA[rem];
        while (start < v.size() && v[start] == 0) ++start;
    }
    out += std::string(zeros, '1');
    std::reverse(out.begin(), out.end());
    return out;
}

std::vector<std::vector<unsigned char>> Inputs(const char* salt, int n)
{
    Rng rng("lineage-props-fixed-seed", salt);
    std::vector<std::vector<unsigned char>> r{{}, {0}, {0, 0, 0}, {0, 0, 1}, {255}, {0, 255, 255}, std::vector<unsigned char>(64, 0), std::vector<unsigned char>(64, 255)};
    for (int i = 0; i < n; ++i) {
        auto v = i % 3 == 0 ? rng.bytes(rng.below(200)) : rng.payload();
        r.push_back(v);
    }
    return r;
}
} // namespace

BOOST_AUTO_TEST_SUITE(lineage_props)

BOOST_AUTO_TEST_CASE(encode_matches_reference)
{
    for (auto& v : Inputs("enc", 600)) BOOST_CHECK_EQUAL(EncodeBase58(v), RefEncode(v));
}

BOOST_AUTO_TEST_CASE(decode_inverts_reference)
{
    for (auto& v : Inputs("dec", 600)) {
        std::vector<unsigned char> out;
        BOOST_CHECK(DecodeBase58(RefEncode(v), out, 1024));
        BOOST_CHECK(out == v);
    }
}

BOOST_AUTO_TEST_CASE(decode_max_ret_len)
{
    for (auto& v : Inputs("lim", 300)) {
        std::vector<unsigned char> out;
        std::string s = RefEncode(v);
        int n = (int)v.size();
        BOOST_CHECK(DecodeBase58(s, out, n));
        if (n > 0) BOOST_CHECK(!DecodeBase58(s, out, n - 1));
    }
}

BOOST_AUTO_TEST_CASE(decode_whitespace_and_garbage)
{
    std::vector<unsigned char> out;
    BOOST_CHECK(DecodeBase58(std::string(" \t2g\n "), out, 10));
    BOOST_CHECK(out == std::vector<unsigned char>{0x61});
    BOOST_CHECK(!DecodeBase58(std::string("2g x"), out, 10));
    BOOST_CHECK(!DecodeBase58(std::string("2 g"), out, 10));
    BOOST_CHECK(!DecodeBase58(std::string("2g\0", 3), out, 10));
    for (char c : std::string("0OIl+/=-_")) BOOST_CHECK(!DecodeBase58(std::string("2") + c + "g", out, 10));
    BOOST_CHECK(DecodeBase58(std::string(""), out, 0));
    BOOST_CHECK(out.empty());
    BOOST_CHECK(!DecodeBase58(std::string("111"), out, 2));
}

BOOST_AUTO_TEST_CASE(check_roundtrip_and_corruption)
{
    for (auto& v : Inputs("chk", 400)) {
        std::string s = EncodeBase58Check(v);
        std::vector<unsigned char> out;
        BOOST_CHECK(DecodeBase58Check(s, out, (int)v.size()));
        BOOST_CHECK(out == v);
        BOOST_CHECK(!DecodeBase58Check(s, out, (int)v.size() - 1) || v.empty());
        std::string m = s;
        char& last = m.back();
        last = last == 'z' ? 'y' : 'z';
        BOOST_CHECK(!DecodeBase58Check(m, out, 1024));
        BOOST_CHECK(out.empty());
    }
}

BOOST_AUTO_TEST_SUITE_END()
