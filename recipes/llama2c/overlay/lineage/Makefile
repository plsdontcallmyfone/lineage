# Lineage build for karpathy/llama2.c (overlay, protected). Builds upstream's tokenizer test
# (test.c, verbatim, as the upstream Makefile's testcc target does) and the lineage harnesses,
# all of which #include run.c. Flags follow upstream's `make run` (-O3, no -march, no OpenMP);
# statically linked so libc and libm code is fixed by the image. Run from the repository root:
# make -f lineage/Makefile -j2
CC      ?= gcc
CFLAGS  := -O3 -ffp-contract=off -g0 -std=gnu11 -Wno-unused-result
LDFLAGS := -static
LDLIBS  := -lm
OUT     := lineage_out

all: $(OUT)/testc $(OUT)/props $(OUT)/bench $(OUT)/equiv $(OUT)/run

$(OUT)/testc: test.c run.c
	@mkdir -p $(OUT)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ test.c $(LDLIBS)

$(OUT)/run: run.c
	@mkdir -p $(OUT)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ run.c $(LDLIBS)

$(OUT)/%: lineage/%.c run.c lineage/seeded.h lineage/model.h lineage/ref_tokenizer.h
	@mkdir -p $(OUT)
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)

.PHONY: all
