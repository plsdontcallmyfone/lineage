# cuda-reduce fixture. SM selects the one GPU architecture the SASS is built for; Lineage recipes
# pass it explicitly so the warp instruction count is fixed by (sm, nvcc, source).
NVCC ?= /usr/local/cuda/bin/nvcc
SM ?= 89
NVCCFLAGS ?= -O3 -std=c++17 -arch=sm_$(SM)

all: build/test_kernels

build/test_kernels: src/kernels.cu src/kernels.cuh tests/test_kernels.cu
	mkdir -p build
	$(NVCC) $(NVCCFLAGS) -o $@ src/kernels.cu tests/test_kernels.cu

test: build/test_kernels
	./build/test_kernels

clean:
	rm -rf build

.PHONY: all test clean
