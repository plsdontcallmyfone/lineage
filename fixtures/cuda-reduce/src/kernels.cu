#include <cstdio>
#include <cstdlib>
#include "kernels.cuh"

#define REDUCE_BLOCK 256

// Block-wise sum in shared memory, then one atomic per block.
__global__ void reduce_sum_kernel(const int* in, unsigned long long* out, int n) {
  __shared__ long long sdata[REDUCE_BLOCK];
  unsigned int tid = threadIdx.x;
  unsigned int i = blockIdx.x * blockDim.x + threadIdx.x;
  sdata[tid] = (i < (unsigned int)n) ? (long long)in[i] : 0;
  __syncthreads();
  for (unsigned int s = 1; s < blockDim.x; s *= 2) {
    if (tid % (2 * s) == 0) {
      sdata[tid] += sdata[tid + s];
    }
    __syncthreads();
  }
  if (tid == 0) atomicAdd(out, (unsigned long long)sdata[0]);
}

// One thread per row.
__global__ void row_scale_kernel(int* m, const int* scale, int rows, int cols) {
  int r = blockIdx.x * blockDim.x + threadIdx.x;
  if (r >= rows) return;
  for (int c = 0; c < cols; ++c) {
    m[(size_t)r * cols + c] *= scale[r];
  }
}

void reduce_sum(const int* d_in, long long* d_out, int n, cudaStream_t stream) {
  CR_CHECK(cudaMemsetAsync(d_out, 0, sizeof(long long), stream));
  if (n <= 0) return;
  int grid = (n + REDUCE_BLOCK - 1) / REDUCE_BLOCK;
  reduce_sum_kernel<<<grid, REDUCE_BLOCK, 0, stream>>>(d_in, (unsigned long long*)d_out, n);
  CR_CHECK(cudaGetLastError());
}

void row_scale(int* d_m, const int* d_scale, int rows, int cols, cudaStream_t stream) {
  if (rows <= 0 || cols <= 0) return;
  int block = 128;
  int grid = (rows + block - 1) / block;
  row_scale_kernel<<<grid, block, 0, stream>>>(d_m, d_scale, rows, cols);
  CR_CHECK(cudaGetLastError());
}
