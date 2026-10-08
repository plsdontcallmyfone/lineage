# amd64 copy for the public site (scripts/deploy/arch-recipes.ts puts it over lineage/Makefile in the
# deployed release on an amd64 server only). One change from the committed overlay: on x86_64,
# src/crypto/sha256.cpp references the SSE4/SSE4.1/AVX2/SHA-NI transforms, which live in separate
# translation units this build does not compile; -DDISABLE_OPTIMIZED_SHA256 keeps the portable C++
# transform, the same code path the arm64 build uses (no ENABLE_ARM_SHANI there). Keep it in step
# with recipes/bitcoin-base58/overlay/lineage/Makefile.
# Lineage build for bitcoin/bitcoin's Base58 codec (overlay, protected). Builds only the
# translation units base58.cpp needs, upstream's own test file src/test/base58_tests.cpp (verbatim,
# against a minimal Boost.Test shim that prints TAP), and the bench and equivalence harnesses.
# Run from the repository root: make -f lineage/Makefile -j2
CXX      ?= g++
CXXFLAGS := -std=c++20 -O2 -g0 -fno-omit-frame-pointer -Wall -Wno-unused-parameter -DDISABLE_OPTIMIZED_SHA256
CPPFLAGS := -Ilineage/shim -Isrc -Isrc/univalue/include -Ilineage_out/gen
LDFLAGS  := -static
OUT      := lineage_out

LIB_SRC := src/base58.cpp src/hash.cpp src/uint256.cpp src/util/strencodings.cpp src/util/string.cpp \
           src/crypto/hex_base.cpp src/crypto/sha256.cpp src/crypto/ripemd160.cpp src/crypto/sha512.cpp \
           src/crypto/hmac_sha512.cpp src/support/cleanse.cpp lineage/check_stub.cpp
UNI_SRC := src/univalue/lib/univalue.cpp src/univalue/lib/univalue_get.cpp src/univalue/lib/univalue_read.cpp \
           src/univalue/lib/univalue_write.cpp src/test/util/json.cpp

LIB_OBJ := $(patsubst %.cpp,$(OUT)/obj/%.o,$(LIB_SRC))
UNI_OBJ := $(patsubst %.cpp,$(OUT)/obj/%.o,$(UNI_SRC))

all: $(OUT)/base58_tests $(OUT)/bench $(OUT)/equiv

$(OUT)/obj/%.o: %.cpp
	@mkdir -p $(dir $@)
	$(CXX) $(CXXFLAGS) $(CPPFLAGS) -c $< -o $@

# The same header CMake generates from the JSON vectors (cmake/script/GenerateHeaderFromJson.cmake).
$(OUT)/gen/test/data/base58_encode_decode.json.h: src/test/data/base58_encode_decode.json
	@mkdir -p $(dir $@)
	{ printf '#include <string_view>\n\nnamespace json_tests {\ninline constexpr char detail_base58_encode_decode_bytes[] {\n'; \
	  od -An -v -tx1 $< | tr -s ' ' '\n' | grep -v '^$$' | sed "s/.*/'\\\\x&',/"; \
	  printf '};\n\ninline constexpr std::string_view base58_encode_decode{std::begin(detail_base58_encode_decode_bytes), std::end(detail_base58_encode_decode_bytes)};\n}\n'; } > $@

$(OUT)/obj/src/test/base58_tests.o: $(OUT)/gen/test/data/base58_encode_decode.json.h

$(OUT)/base58_tests: $(OUT)/obj/src/test/base58_tests.o $(OUT)/obj/lineage/props_tests.o $(OUT)/obj/lineage/tap_main.o $(LIB_OBJ) $(UNI_OBJ)
	$(CXX) $(LDFLAGS) -o $@ $^

$(OUT)/bench: $(OUT)/obj/lineage/bench.o $(LIB_OBJ)
	$(CXX) $(LDFLAGS) -o $@ $^

$(OUT)/equiv: $(OUT)/obj/lineage/equiv.o $(LIB_OBJ)
	$(CXX) $(LDFLAGS) -o $@ $^

.PHONY: all
