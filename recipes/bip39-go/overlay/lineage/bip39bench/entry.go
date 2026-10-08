package main

import (
	"runtime"
	_ "unsafe" // for go:linkname
)

// The main goroutine stays on the main thread for the whole run. Otherwise, after any blocking
// syscall (reading inputs), it may resume on whichever thread picked up its P, and every
// thread has its own runtime random state, so the hash seeds of maps created afterwards (the
// vocabulary and merge tables, the type caches) differed from run to run, and with them the
// number of probes per lookup.
func init() { runtime.LockOSThread() }

// lineageEntry is the process entry point of the cachegrind build (see entry_arm64.s).
func lineageEntry()

// procPin and procUnpin are the runtime's own P-pinning helpers (used by sync.Pool); the
// runtime allows linkname access to them (go.dev/issue/67401).
//
//go:linkname procPin runtime.procPin
func procPin() int

//go:linkname procUnpin runtime.procUnpin
func procUnpin()
