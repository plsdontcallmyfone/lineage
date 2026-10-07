// Minimal Boost.Test stand-in for the lineage harness (overlay, protected). Upstream test files
// compile against it verbatim. Every test case is one TAP line "<suite>::<case>"; a case fails
// when any of its checks fails (each failing check is printed as a TAP diagnostic).
#pragma once
#include <functional>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace lineage_test {
struct Case {
    std::string suite, name;
    std::function<void()> fn;
};
inline std::vector<Case>& registry() { static std::vector<Case> r; return r; }
inline int& failures() { static int f = 0; return f; }
inline std::string& current_suite() { static std::string s; return s; }
struct Registrar {
    Registrar(const char* suite, const char* name, std::function<void()> fn) { registry().push_back({suite, name, std::move(fn)}); }
};
struct SuiteSetter {
    explicit SuiteSetter(const char* s) { current_suite() = s; }
};
inline void fail(const char* file, int line, const std::string& what) {
    ++failures();
    std::cout << "# check failed at " << file << ":" << line << ": " << what << "\n";
}
} // namespace lineage_test

#define LINEAGE_CAT2(a, b) a##b
#define LINEAGE_CAT(a, b) LINEAGE_CAT2(a, b)

#define BOOST_FIXTURE_TEST_SUITE(suite, fixture) \
    namespace suite { using lineage_fixture = fixture; static const char* lineage_suite_name = #suite;
#define BOOST_AUTO_TEST_SUITE(suite) \
    namespace suite { struct lineage_fixture {}; static const char* lineage_suite_name = #suite;
#define BOOST_AUTO_TEST_SUITE_END() }

#define BOOST_AUTO_TEST_CASE(name)                                                         \
    struct name : lineage_fixture { void test_method(); };                                 \
    static lineage_test::Registrar LINEAGE_CAT(lineage_reg_, name)(lineage_suite_name, #name, [] { name t; t.test_method(); }); \
    void name::test_method()

#define BOOST_CHECK_MESSAGE(cond, msg)                                                     \
    do { if (!(cond)) { std::ostringstream lineage_os; lineage_os << msg; lineage_test::fail(__FILE__, __LINE__, lineage_os.str()); } } while (0)
#define BOOST_CHECK(cond) BOOST_CHECK_MESSAGE(cond, #cond)
#define BOOST_REQUIRE(cond) BOOST_CHECK(cond)
#define BOOST_ERROR(msg) BOOST_CHECK_MESSAGE(false, msg)
#define BOOST_CHECK_EQUAL(a, b) BOOST_CHECK_MESSAGE((a) == (b), #a " == " #b)
#define BOOST_CHECK_EQUAL_COLLECTIONS(b1, e1, b2, e2) \
    BOOST_CHECK_MESSAGE(std::equal(b1, e1, b2, e2), "collections differ: " #b1 " .. " #e1)
