// amd64 counterpart of entry_arm64.s for the public site (scripts/deploy/arch-recipes.ts copies it
// into the deployed release's overlay on an amd64 server only; the committed arm64 recipe is
// unchanged). Same two steps, then a jump to the normal Go entry with SP and every register the
// kernel set up unchanged:
//
// 1. Fixes the runtime's random seed: overwrites the 16 AT_RANDOM bytes of the auxiliary vector
//    with a fixed non-zero constant, so map hash seeds (and the heap base) are the same every run.
// 2. Pre-touches 512 KB of main-thread stack, as on arm64 (harmless on amd64, where valgrind
//    also accepts the 128-byte red zone below SP).
//
// Only the harness binary uses this entry; the code under test is unchanged.
#include "textflag.h"

TEXT main·lineageEntry(SB),NOSPLIT|NOFRAME,$0
	// auxv starts after argc, argv[argc], NULL, envp..., NULL
	MOVQ	SP, AX
	MOVQ	0(AX), BX
	LEAQ	16(AX)(BX*8), DX
env:
	MOVQ	0(DX), CX
	ADDQ	$8, DX
	TESTQ	CX, CX
	JNZ	env
aux:
	MOVQ	0(DX), CX
	TESTQ	CX, CX
	JZ	probe0
	CMPQ	CX, $25 // AT_RANDOM
	JNE	next
	MOVQ	8(DX), SI
	MOVQ	$0x316567616e696c, DI // any fixed non-zero value; all-zero seeds are rejected
	MOVQ	DI, 0(SI)
	MOVQ	DI, 8(SI)
next:
	ADDQ	$16, DX
	JMP	aux
probe0:
	MOVQ	SP, R9
	MOVQ	$128, R10
probe:
	SUBQ	$4096, SP
	MOVQ	$0, 0(SP)
	DECQ	R10
	JNZ	probe
	MOVQ	R9, SP
	JMP	_rt0_amd64_linux(SB)
