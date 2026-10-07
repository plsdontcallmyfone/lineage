// Lineage harness for the cuda-reduce fixture (recipe overlay, always protected).
//
//   lineage_harness bench reduce|scale <seed>   one launch of one kernel on seeded input (run under ncu)
//   lineage_harness time  reduce|scale <seed>   median kernel time in microseconds from CUDA events
//   lineage_harness equiv <seed>                exact outputs for seeded inputs (stdout is digested)
//
// The seed only changes the input data and, slightly, the problem size, so a patch cannot special
// case the measured input (SPEC 6, holdout). Everything is integer arithmetic: outputs are exact.
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
#include "../src/kernels.cuh"

static uint64_t fnv1a(const char* s) {
  uint64_t h = 0xcbf29ce484222325ULL;
  for (; *s; ++s) h = (h ^ (uint8_t)*s) * 0x100000001b3ULL;
  return h;
}

struct Rng {
  uint64_t s;
  explicit Rng(uint64_t seed) : s(seed ? seed : 1) {}
  uint32_t u32() {
    s ^= s << 13;
    s ^= s >> 7;
    s ^= s << 17;
    return (uint32_t)(s >> 16);
  }
  int range(int lo, int hi) { return lo + (int)(u32() % (uint32_t)(hi - lo + 1)); }
};

struct Shapes {
  int n;           // reduce length
  int rows, cols;  // row_scale shape
};

static Shapes bench_shapes(uint64_t h) {
  Shapes s;
  s.n = (1 << 22) + (int)(h % 65536);
  s.rows = 2048 + (int)((h >> 16) % 256);
  s.cols = 6000 + (int)((h >> 24) % 512);
  return s;
}

struct ReduceBuf {
  int* d_in = nullptr;
  long long* d_out = nullptr;
  int n = 0;
  ReduceBuf(int n_, Rng& rng) : n(n_) {
    std::vector<int> h(n);
    for (auto& v : h) v = rng.range(-1000, 1000);
    CR_CHECK(cudaMalloc(&d_in, sizeof(int) * (size_t)n));
    CR_CHECK(cudaMalloc(&d_out, sizeof(long long)));
    CR_CHECK(cudaMemcpy(d_in, h.data(), sizeof(int) * (size_t)n, cudaMemcpyHostToDevice));
  }
  ~ReduceBuf() {
    cudaFree(d_in);
    cudaFree(d_out);
  }
  void run() { reduce_sum(d_in, d_out, n); }
  long long result() {
    long long r = 0;
    CR_CHECK(cudaMemcpy(&r, d_out, sizeof(r), cudaMemcpyDeviceToHost));
    return r;
  }
};

struct ScaleBuf {
  int* d_m = nullptr;
  int* d_s = nullptr;
  int rows, cols;
  std::vector<int> h_m, h_s;
  ScaleBuf(int r, int c, Rng& rng) : rows(r), cols(c), h_m((size_t)r * c), h_s(r) {
    for (auto& v : h_m) v = rng.range(-50, 50);
    for (auto& v : h_s) v = rng.range(-7, 7);
    CR_CHECK(cudaMalloc(&d_m, sizeof(int) * h_m.size()));
    CR_CHECK(cudaMalloc(&d_s, sizeof(int) * h_s.size()));
    reset();
    CR_CHECK(cudaMemcpy(d_s, h_s.data(), sizeof(int) * h_s.size(), cudaMemcpyHostToDevice));
  }
  ~ScaleBuf() {
    cudaFree(d_m);
    cudaFree(d_s);
  }
  void reset() { CR_CHECK(cudaMemcpy(d_m, h_m.data(), sizeof(int) * h_m.size(), cudaMemcpyHostToDevice)); }
  void run() { row_scale(d_m, d_s, rows, cols); }
  uint64_t digest() {
    std::vector<int> out(h_m.size());
    CR_CHECK(cudaMemcpy(out.data(), d_m, sizeof(int) * out.size(), cudaMemcpyDeviceToHost));
    uint64_t h = 0xcbf29ce484222325ULL;
    for (int v : out) {
      uint32_t u = (uint32_t)v;
      for (int k = 0; k < 4; ++k) h = (h ^ ((u >> (8 * k)) & 0xff)) * 0x100000001b3ULL;
    }
    return h;
  }
};

static int usage() {
  fprintf(stderr, "usage: lineage_harness bench|time reduce|scale <seed> | equiv <seed>\n");
  return 2;
}

int main(int argc, char** argv) {
  if (argc < 3) return usage();
  const char* mode = argv[1];
  CR_CHECK(cudaSetDevice(0));
  CR_CHECK(cudaFree(0));  // create the context before anything is measured

  if (!strcmp(mode, "equiv")) {
    uint64_t h = fnv1a(argv[2]);
    Rng rng(h);
    // Sizes cover the tails a patch could get wrong and the large shapes tests do not use.
    for (int i = 0; i < 6; ++i) {
      int n = i < 3 ? rng.range(1, 2048) : rng.range(100000, 3000000);
      ReduceBuf b(n, rng);
      b.run();
      printf("reduce n=%d sum=%lld\n", n, b.result());
    }
    for (int i = 0; i < 6; ++i) {
      int rows = i < 3 ? rng.range(1, 300) : rng.range(500, 3000);
      int cols = i < 3 ? rng.range(1, 300) : rng.range(4000, 9000);
      ScaleBuf b(rows, cols, rng);
      b.run();
      printf("row_scale %dx%d digest=%016llx\n", rows, cols, (unsigned long long)b.digest());
    }
    CR_CHECK(cudaDeviceSynchronize());
    return 0;
  }

  if (argc < 4) return usage();
  const char* kernel = argv[2];
  uint64_t h = fnv1a(argv[3]);
  Shapes s = bench_shapes(h);
  Rng rng(h ^ 0x5eedULL);
  bool reduce = !strcmp(kernel, "reduce");
  if (!reduce && strcmp(kernel, "scale")) return usage();

  if (!strcmp(mode, "bench")) {
    if (reduce) {
      ReduceBuf b(s.n, rng);
      b.run();
      CR_CHECK(cudaDeviceSynchronize());
      fprintf(stderr, "reduce n=%d sum=%lld\n", s.n, b.result());
    } else {
      ScaleBuf b(s.rows, s.cols, rng);
      b.run();
      CR_CHECK(cudaDeviceSynchronize());
      fprintf(stderr, "row_scale %dx%d\n", s.rows, s.cols);
    }
    return 0;
  }

  if (!strcmp(mode, "time")) {
    const int warm = 3, reps = 25;
    std::vector<float> ms;
    cudaEvent_t a, b;
    CR_CHECK(cudaEventCreate(&a));
    CR_CHECK(cudaEventCreate(&b));
    ReduceBuf* rb = reduce ? new ReduceBuf(s.n, rng) : nullptr;
    ScaleBuf* sb = reduce ? nullptr : new ScaleBuf(s.rows, s.cols, rng);
    for (int i = 0; i < warm + reps; ++i) {
      if (sb) sb->reset();
      CR_CHECK(cudaDeviceSynchronize());
      CR_CHECK(cudaEventRecord(a));
      if (rb) rb->run();
      else sb->run();
      CR_CHECK(cudaEventRecord(b));
      CR_CHECK(cudaEventSynchronize(b));
      float t = 0;
      CR_CHECK(cudaEventElapsedTime(&t, a, b));
      if (i >= warm) ms.push_back(t);
    }
    std::sort(ms.begin(), ms.end());
    printf("%.3f\n", ms[ms.size() / 2] * 1000.0f);
    delete rb;
    delete sb;
    return 0;
  }
  return usage();
}
