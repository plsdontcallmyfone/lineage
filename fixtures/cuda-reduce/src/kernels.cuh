// cuda-reduce: a tiny CUDA library used as the Lineage cuda-class fixture.
// Integer kernels only, so every output is bit exact and comparable to a CPU reference.
#pragma once
#include <cstdio>
#include <cstdlib>
#include <cuda_runtime.h>

// Sum of n ints into *d_out (device pointer, one long long). Launches reduce_sum_kernel.
void reduce_sum(const int* d_in, long long* d_out, int n, cudaStream_t stream = 0);

// m[r * cols + c] *= scale[r] for every row r < rows. Launches row_scale_kernel.
void row_scale(int* d_m, const int* d_scale, int rows, int cols, cudaStream_t stream = 0);

#define CR_CHECK(call)                                                                       \
  do {                                                                                       \
    cudaError_t err_ = (call);                                                               \
    if (err_ != cudaSuccess) {                                                               \
      fprintf(stderr, "CUDA error %s at %s:%d\n", cudaGetErrorString(err_), __FILE__, __LINE__); \
      exit(3);                                                                               \
    }                                                                                        \
  } while (0)
