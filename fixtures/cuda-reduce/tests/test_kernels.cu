// Unit tests: every kernel is compared to a CPU reference. Output is TAP.
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include "../src/kernels.cuh"

static uint64_t rng_state = 0x9e3779b97f4a7c15ULL;
static uint32_t next_u32() {
  rng_state ^= rng_state << 13;
  rng_state ^= rng_state >> 7;
  rng_state ^= rng_state << 17;
  return (uint32_t)(rng_state >> 16);
}
static int next_int(int lo, int hi) { return lo + (int)(next_u32() % (uint32_t)(hi - lo + 1)); }

static int test_no = 0;
static int failures = 0;
static void report(bool ok, const std::string& name, const std::string& detail = "") {
  ++test_no;
  if (!ok) ++failures;
  printf("%s %d - %s\n", ok ? "ok" : "not ok", test_no, name.c_str());
  if (!ok && !detail.empty()) printf("  # %s\n", detail.c_str());
}

static void test_reduce(int n) {
  std::vector<int> h(n > 0 ? n : 1);
  long long want = 0;
  for (int i = 0; i < n; ++i) {
    h[i] = next_int(-1000, 1000);
    want += h[i];
  }
  int* d_in = nullptr;
  long long* d_out = nullptr;
  CR_CHECK(cudaMalloc(&d_in, sizeof(int) * h.size()));
  CR_CHECK(cudaMalloc(&d_out, sizeof(long long)));
  CR_CHECK(cudaMemcpy(d_in, h.data(), sizeof(int) * h.size(), cudaMemcpyHostToDevice));
  reduce_sum(d_in, d_out, n);
  long long got = 0;
  CR_CHECK(cudaMemcpy(&got, d_out, sizeof(long long), cudaMemcpyDeviceToHost));
  CR_CHECK(cudaFree(d_in));
  CR_CHECK(cudaFree(d_out));
  report(got == want, "reduce_sum_n" + std::to_string(n), "got " + std::to_string(got) + " want " + std::to_string(want));
}

static void test_row_scale(int rows, int cols) {
  size_t total = (size_t)rows * cols;
  std::vector<int> m(total), scale(rows), want(total);
  for (size_t i = 0; i < total; ++i) m[i] = next_int(-50, 50);
  for (int r = 0; r < rows; ++r) scale[r] = next_int(-7, 7);
  for (int r = 0; r < rows; ++r)
    for (int c = 0; c < cols; ++c) want[(size_t)r * cols + c] = m[(size_t)r * cols + c] * scale[r];
  int *d_m = nullptr, *d_s = nullptr;
  CR_CHECK(cudaMalloc(&d_m, sizeof(int) * total));
  CR_CHECK(cudaMalloc(&d_s, sizeof(int) * rows));
  CR_CHECK(cudaMemcpy(d_m, m.data(), sizeof(int) * total, cudaMemcpyHostToDevice));
  CR_CHECK(cudaMemcpy(d_s, scale.data(), sizeof(int) * rows, cudaMemcpyHostToDevice));
  row_scale(d_m, d_s, rows, cols);
  CR_CHECK(cudaMemcpy(m.data(), d_m, sizeof(int) * total, cudaMemcpyDeviceToHost));
  CR_CHECK(cudaFree(d_m));
  CR_CHECK(cudaFree(d_s));
  size_t bad = 0;
  for (size_t i = 0; i < total; ++i) bad += m[i] != want[i];
  report(bad == 0, "row_scale_" + std::to_string(rows) + "x" + std::to_string(cols), std::to_string(bad) + " wrong cells");
}

int main() {
  printf("TAP version 13\n");
  const int sizes[] = {0, 1, 255, 256, 257, 1000, 65536, 100003};
  for (int n : sizes) test_reduce(n);
  const int shapes[][2] = {{1, 1}, {1, 300}, {127, 3}, {128, 64}, {129, 17}, {300, 1000}};
  for (auto& s : shapes) test_row_scale(s[0], s[1]);
  printf("1..%d\n", test_no);
  return failures ? 1 : 0;
}
