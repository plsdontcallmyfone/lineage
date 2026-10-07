// Stand-in for src/util/check.cpp (overlay, protected), which needs the CMake-generated
// bitcoin-build-config.h and clientversion. Same observable behaviour for the harness: a failed
// Assert/CHECK_NONFATAL prints where and aborts (or throws when a test asked for exceptions).
#include <util/check.h>

#include <cstdio>
#include <cstdlib>
#include <string>

std::atomic<bool> g_enable_dynamic_fuzz_determinism{false};
bool g_detail_test_only_CheckFailuresAreExceptionsNotAborts{false};

std::string StrFormatInternalBug(std::string_view msg, const std::source_location& loc)
{
    return std::string("Internal bug detected: ") + std::string(msg) + " at " + loc.file_name() + ":" + std::to_string(loc.line()) + " (" + loc.function_name() + ")";
}

NonFatalCheckError::NonFatalCheckError(std::string_view msg, const std::source_location& loc)
    : std::runtime_error{StrFormatInternalBug(msg, loc)} {}

void assertion_fail(const std::source_location& loc, std::string_view assertion)
{
    if (g_detail_test_only_CheckFailuresAreExceptionsNotAborts) throw NonFatalCheckError{assertion, loc};
    std::fprintf(stderr, "%s:%u %s: Assertion `%.*s' failed.\n", loc.file_name(), (unsigned)loc.line(), loc.function_name(), (int)assertion.size(), assertion.data());
    std::abort();
}
