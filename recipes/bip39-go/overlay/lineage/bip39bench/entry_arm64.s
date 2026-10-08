// Process entry for the measurement harness (linked with -ldflags=-E=main.lineageEntry).
// It does two things, then jumps to the normal Go entry point with SP and every register the
// kernel set up unchanged (argc, argv, envp and auxv are untouched apart from the bytes below):
//
// 1. Fixes the runtime's random seed. Go seeds all runtime randomness (map hash seeds, sync.Map
//    hashes, heap base) from the 16 AT_RANDOM bytes in the auxiliary vector. Per-process map
//    seeds change how many probes each map lookup makes, which moved instruction counts by up
//    to ~2e-4 between identical runs. The stub overwrites those 16 bytes with a fixed
//    non-zero constant (the runtime falls back to /dev/urandom for all-zero bytes), so every run of the
//    harness uses the same seeds. Base and candidate run the same harness, so a patch cannot
//    benefit from this.
// 2. Pre-touches 512 KB of main-thread stack. Valgrind grows the main stack only for faults at
//    or above SP (arm64 has no red zone), but the Go runtime sets up large g0 frames by storing
//    below SP before moving it (runtime.getCPUCount's 8 KB frame is the first), so a Go binary
//    otherwise dies at start-up under valgrind.
//
// Only the harness binary uses this entry; the code under test is unchanged.
#include "textflag.h"

TEXT main·lineageEntry(SB),NOSPLIT|NOFRAME,$0
	// auxv starts after argc, argv[argc], NULL, envp..., NULL
	MOVD	RSP, R0
	MOVD	0(R0), R1
	ADD	$2, R1, R2
	LSL	$3, R2, R2
	ADD	R0, R2, R2
env:
	MOVD	0(R2), R3
	ADD	$8, R2, R2
	CBNZ	R3, env
aux:
	MOVD	0(R2), R3
	CBZ	R3, probe0
	CMP	$25, R3 // AT_RANDOM
	BNE	next
	MOVD	8(R2), R4
	MOVD	$0x316567616e696c, R5 // any fixed non-zero value; all-zero seeds are rejected
	MOVD	R5, 0(R4)
	MOVD	R5, 8(R4)
next:
	ADD	$16, R2, R2
	B	aux
probe0:
	MOVD	RSP, R9
	MOVD	$128, R10
probe:
	SUB	$4096, RSP, R11
	MOVD	R11, RSP
	MOVD	ZR, (RSP)
	SUB	$1, R10
	CBNZ	R10, probe
	MOVD	R9, RSP
	B	_rt0_arm64_linux(SB)
