// Lineage harness for karpathy/llm.c production kernels (recipe overlay, always protected).
// llm.c is MIT licensed; the CPU references below follow the ones in llm.c dev/cuda/*.cu.
//
//   lineage_harness test                  TAP: every kernel in the allowed files vs a CPU reference
//   lineage_harness equiv <seed>          ok/FAIL per kernel on seeded shapes and data (stdout digested)
//   lineage_harness bench <kernel> <seed> one launch of one kernel on GPT-2 small shapes (run under ncu)
//   lineage_harness time  <kernel> <seed> median kernel time in microseconds from CUDA events
//
// kernels for bench/time: encoder_fwd layernorm_fwd fused_residual_fwd residual_fwd gelu_fwd gelu_bwd
//
// Outputs are bf16, and a correct patch may legitimately reorder float sums, so comparisons use a
// tolerance against the CPU reference instead of bit equality. Equivalence therefore prints only
// pass/fail per check: a patch changes the digest exactly when it moves some output out of tolerance
// on inputs the author never saw.
#include <algorithm>
#include <cassert>  // llmc/cuda_utils.cuh uses assert without including it
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "../llmc/cuda_common.h"
#include "../llmc/cuda_utils.cuh"
#include "../llmc/encoder.cuh"
#include "../llmc/layernorm.cuh"
#include "../llmc/gelu.cuh"

cudaDeviceProp deviceProp;

static_assert(sizeof(floatX) == 2, "harness expects the default bf16 build of llm.c");

// ------------------------------------------------------------------------------------------------
// host helpers

typedef std::vector<uint16_t> bfvec;

static uint16_t f2bf(float f) {
  uint32_t u;
  memcpy(&u, &f, 4);
  if ((u & 0x7fffffffu) > 0x7f800000u) return 0x7fc0;
  uint32_t r = 0x7fffu + ((u >> 16) & 1u);
  return (uint16_t)((u + r) >> 16);
}
static float bf2f(uint16_t b) {
  uint32_t u = (uint32_t)b << 16;
  float f;
  memcpy(&f, &u, 4);
  return f;
}

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
  float uniform(float lo, float hi) { return lo + (hi - lo) * (float)(u32() & 0xffffff) / 16777216.0f; }
  int range(int lo, int hi) { return lo + (int)(u32() % (uint32_t)(hi - lo + 1)); }
};

static bfvec rand_bf(size_t n, Rng& r, float lo, float hi) {
  bfvec v(n);
  for (auto& x : v) x = f2bf(r.uniform(lo, hi));
  return v;
}
static std::vector<float> to_f(const bfvec& v) {
  std::vector<float> o(v.size());
  for (size_t i = 0; i < v.size(); ++i) o[i] = bf2f(v[i]);
  return o;
}

template <class T>
static T* dmalloc(size_t n) {
  T* p = nullptr;
  cudaCheck(cudaMalloc(&p, sizeof(T) * (n ? n : 1)));
  return p;
}
static floatX* up(const bfvec& v) {
  floatX* d = dmalloc<floatX>(v.size());
  cudaCheck(cudaMemcpy(d, v.data(), 2 * v.size(), cudaMemcpyHostToDevice));
  return d;
}
template <class T>
static T* upT(const std::vector<T>& v) {
  T* d = dmalloc<T>(v.size());
  cudaCheck(cudaMemcpy(d, v.data(), sizeof(T) * v.size(), cudaMemcpyHostToDevice));
  return d;
}
static bfvec down(const floatX* d, size_t n) {
  bfvec v(n);
  cudaCheck(cudaMemcpy(v.data(), d, 2 * n, cudaMemcpyDeviceToHost));
  return v;
}
template <class T>
static std::vector<T> downT(const T* d, size_t n) {
  std::vector<T> v(n);
  cudaCheck(cudaMemcpy(v.data(), d, sizeof(T) * n, cudaMemcpyDeviceToHost));
  return v;
}

// |gpu - ref| <= atol + rtol * |ref| for every element in [0, n)
struct Cmp {
  bool ok = true;
  size_t bad = 0;
};
static Cmp close_bf(const bfvec& g, const std::vector<float>& r, size_t n, float rtol, float atol) {
  Cmp c;
  for (size_t i = 0; i < n; ++i) {
    float x = bf2f(g[i]);
    if (!(fabsf(x - r[i]) <= atol + rtol * fabsf(r[i]))) c.bad++;
  }
  c.ok = c.bad == 0;
  return c;
}
static Cmp close_f(const std::vector<float>& g, const std::vector<float>& r, size_t n, float rtol, float atol) {
  Cmp c;
  for (size_t i = 0; i < n; ++i)
    if (!(fabsf(g[i] - r[i]) <= atol + rtol * fabsf(r[i]))) c.bad++;
  c.ok = c.bad == 0;
  return c;
}

const float BF_RTOL = 2e-2f, BF_ATOL = 2e-2f;  // bf16 outputs (8-bit significand)
const float F_RTOL = 1e-3f, F_ATOL = 1e-4f;    // float outputs (mean, rstd)
const uint16_t GUARD = 0x7fc1;                 // a NaN pattern no kernel produces
const float GUARD_F = -12345.0f;

// ------------------------------------------------------------------------------------------------
// CPU references (float math on the bf16 inputs)

static float round_bf(float x) { return bf2f(f2bf(x)); }

static void ref_layernorm(std::vector<float>& out, std::vector<float>& mean, std::vector<float>& rstd, const std::vector<float>& x,
                          const std::vector<float>& w, const std::vector<float>& b, int N, int C) {
  for (int i = 0; i < N; ++i) {
    const float* xi = &x[(size_t)i * C];
    double m = 0;
    for (int c = 0; c < C; ++c) m += xi[c];
    m /= C;
    double v = 0;
    for (int c = 0; c < C; ++c) v += (xi[c] - m) * (xi[c] - m);
    v /= C;
    float s = (float)(1.0 / sqrt(v + 1e-5));
    for (int c = 0; c < C; ++c) out[(size_t)i * C + c] = s * (xi[c] - (float)m) * w[c] + b[c];
    mean[i] = (float)m;
    rstd[i] = s;
  }
}

static float gelu_ref(float x) {
  const float k = sqrtf(2.0f / (float)M_PI);
  return 0.5f * x * (1.0f + tanhf(k * (x + 0.044715f * x * x * x)));
}
static float gelu_grad_ref(float x) {
  const float k = sqrtf(2.0f / (float)M_PI);
  float a = k * (x + 0.044715f * x * x * x);
  float t = tanhf(a);
  float ch = coshf(a);
  float sech = 1.0f / (ch * ch);
  return 0.5f * (1.0f + t) + x * 0.5f * sech * k * (1.0f + 3.0f * 0.044715f * x * x);
}

// ------------------------------------------------------------------------------------------------
// checks: each returns ok and is reused by `test` (fixed seeds) and `equiv` (holdout seed)

static bool check_encoder_fwd(int B, int T, int C, int V, Rng& r) {
  int N = B * T;
  std::vector<int> inp(N);
  for (auto& t : inp) t = r.range(0, V - 1);
  bfvec wte = rand_bf((size_t)V * C, r, -1, 1), wpe = rand_bf((size_t)T * C, r, -1, 1);
  int* d_inp = upT(inp);
  floatX *d_wte = up(wte), *d_wpe = up(wpe), *d_out = dmalloc<floatX>((size_t)N * C);
  encoder_forward(d_out, d_inp, d_wte, d_wpe, B, T, C, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec out = down(d_out, (size_t)N * C);
  std::vector<float> ref((size_t)N * C);
  for (int b = 0; b < B; ++b)
    for (int t = 0; t < T; ++t)
      for (int c = 0; c < C; ++c)
        ref[((size_t)b * T + t) * C + c] = bf2f(wte[(size_t)inp[b * T + t] * C + c]) + bf2f(wpe[(size_t)t * C + c]);
  cudaFree(d_inp); cudaFree(d_wte); cudaFree(d_wpe); cudaFree(d_out);
  return close_bf(out, ref, ref.size(), BF_RTOL, BF_ATOL).ok;
}

// guard_rows: extra rows after N in every buffer, filled with a sentinel that must survive.
static bool check_layernorm_fwd(int B, int T, int C, Rng& r, bool guard_only) {
  int N = B * T, G = 8;
  bfvec x = rand_bf((size_t)(N + G) * C, r, -2, 2), w = rand_bf(C, r, -1, 1), bb = rand_bf(C, r, -1, 1);
  floatX *d_x = up(x), *d_w = up(w), *d_b = up(bb);
  bfvec out0((size_t)(N + G) * C, GUARD);
  floatX* d_out = up(out0);
  std::vector<float> st0(N + G, GUARD_F);
  float *d_mean = upT(st0), *d_rstd = upT(st0);
  layernorm_forward(d_out, d_mean, d_rstd, d_x, d_w, d_b, B, T, C, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec out = down(d_out, (size_t)(N + G) * C);
  std::vector<float> mean = downT(d_mean, N + G), rstd = downT(d_rstd, N + G);
  cudaFree(d_x); cudaFree(d_w); cudaFree(d_b); cudaFree(d_out); cudaFree(d_mean); cudaFree(d_rstd);
  if (guard_only) {
    for (size_t i = (size_t)N * C; i < out.size(); ++i) if (out[i] != GUARD) return false;
    for (int i = N; i < N + G; ++i) if (mean[i] != GUARD_F || rstd[i] != GUARD_F) return false;
    return true;
  }
  std::vector<float> ro((size_t)N * C), rm(N), rr(N);
  ref_layernorm(ro, rm, rr, to_f(x), to_f(w), to_f(bb), N, C);
  return close_bf(out, ro, ro.size(), BF_RTOL, BF_ATOL).ok && close_f(mean, rm, N, F_RTOL, F_ATOL).ok && close_f(rstd, rr, N, F_RTOL, F_ATOL).ok;
}

static bool check_residual_fwd(int N, Rng& r) {
  bfvec a = rand_bf(N, r, -2, 2), b = rand_bf(N, r, -2, 2);
  floatX *d_a = up(a), *d_b = up(b), *d_o = dmalloc<floatX>(N);
  residual_forward(d_o, d_a, d_b, N, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec o = down(d_o, N);
  std::vector<float> ref(N);
  for (int i = 0; i < N; ++i) ref[i] = bf2f(a[i]) + bf2f(b[i]);
  cudaFree(d_a); cudaFree(d_b); cudaFree(d_o);
  return close_bf(o, ref, N, BF_RTOL, BF_ATOL).ok;
}

static bool check_fused_residual_fwd(int B, int T, int C, Rng& r, bool guard_only) {
  int N = B * T, G = 8;
  size_t NC = (size_t)N * C, GC = (size_t)(N + G) * C;
  bfvec a = rand_bf(GC, r, -2, 2), b = rand_bf(GC, r, -2, 2), w = rand_bf(C, r, -1, 1), bb = rand_bf(C, r, -1, 1);
  floatX *d_a = up(a), *d_b = up(b), *d_w = up(w), *d_bb = up(bb);
  bfvec g0(GC, GUARD);
  floatX *d_res = up(g0), *d_norm = up(g0);
  std::vector<float> st0(N + G, GUARD_F);
  float *d_mean = upT(st0), *d_rstd = upT(st0);
  fused_residual_forward5(d_res, d_norm, d_mean, d_rstd, d_a, d_b, d_w, d_bb, N, C, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec res = down(d_res, GC), norm = down(d_norm, GC);
  std::vector<float> mean = downT(d_mean, N + G), rstd = downT(d_rstd, N + G);
  cudaFree(d_a); cudaFree(d_b); cudaFree(d_w); cudaFree(d_bb); cudaFree(d_res); cudaFree(d_norm); cudaFree(d_mean); cudaFree(d_rstd);
  if (guard_only) {
    for (size_t i = NC; i < GC; ++i) if (res[i] != GUARD || norm[i] != GUARD) return false;
    for (int i = N; i < N + G; ++i) if (mean[i] != GUARD_F || rstd[i] != GUARD_F) return false;
    return true;
  }
  std::vector<float> rres(NC);
  for (size_t i = 0; i < NC; ++i) rres[i] = round_bf(bf2f(a[i]) + bf2f(b[i]));  // stored as bf16 before the norm
  std::vector<float> ro(NC), rm(N), rr(N);
  ref_layernorm(ro, rm, rr, rres, to_f(w), to_f(bb), N, C);
  return close_bf(res, rres, NC, BF_RTOL, BF_ATOL).ok && close_bf(norm, ro, NC, BF_RTOL, BF_ATOL).ok && close_f(mean, rm, N, F_RTOL, F_ATOL).ok &&
         close_f(rstd, rr, N, F_RTOL, F_ATOL).ok;
}

static bool check_gelu_fwd(int N, Rng& r, float range) {
  bfvec x = rand_bf(N, r, -range, range);
  floatX *d_x = up(x), *d_o = dmalloc<floatX>(N);
  gelu_forward(d_o, d_x, N, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec o = down(d_o, N);
  std::vector<float> ref(N);
  for (int i = 0; i < N; ++i) ref[i] = gelu_ref(bf2f(x[i]));
  cudaFree(d_x); cudaFree(d_o);
  return close_bf(o, ref, N, BF_RTOL, BF_ATOL).ok;
}

static bool check_gelu_bwd(int N, Rng& r, float range) {
  bfvec x = rand_bf(N, r, -range, range), d = rand_bf(N, r, -1, 1);
  floatX *d_x = up(x), *d_d = up(d);
  gelu_backward_inplace(d_d, d_x, N, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec o = down(d_d, N);
  std::vector<float> ref(N);
  for (int i = 0; i < N; ++i) ref[i] = gelu_grad_ref(bf2f(x[i])) * bf2f(d[i]);
  cudaFree(d_x); cudaFree(d_d);
  return close_bf(o, ref, N, BF_RTOL, BF_ATOL).ok;
}

static bool check_layernorm_bwd(int B, int T, int C, Rng& r) {
  int N = B * T;
  size_t NC = (size_t)N * C;
  bfvec x = rand_bf(NC, r, -2, 2), w = rand_bf(C, r, -1, 1), dout = rand_bf(NC, r, -1, 1);
  bfvec dinp0 = rand_bf(NC, r, -0.5f, 0.5f), dw0 = rand_bf(C, r, -0.5f, 0.5f), db0 = rand_bf(C, r, -0.5f, 0.5f);
  std::vector<float> xf = to_f(x), wf = to_f(w), dof = to_f(dout);
  // mean and rstd from the reference forward, as the training loop would cache them
  std::vector<float> tmp(NC), mean(N), rstd(N), ones(C, 1.0f), zeros(C, 0.0f);
  ref_layernorm(tmp, mean, rstd, xf, ones, zeros, N, C);
  floatX *d_x = up(x), *d_w = up(w), *d_dout = up(dout), *d_dinp = up(dinp0), *d_dw = up(dw0), *d_db = up(db0);
  float *d_mean = upT(mean), *d_rstd = upT(rstd);
  size_t scratch_n = 32 + (size_t)2 * C * 4096;
  float* d_scratch = dmalloc<float>(scratch_n);
  cudaCheck(cudaMemset(d_scratch, 0, sizeof(float) * scratch_n));
  layernorm_backward(d_dinp, d_dw, d_db, d_scratch, d_dout, d_x, d_w, d_mean, d_rstd, B, T, C, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec dinp = down(d_dinp, NC), dw = down(d_dw, C), db = down(d_db, C);
  cudaFree(d_x); cudaFree(d_w); cudaFree(d_dout); cudaFree(d_dinp); cudaFree(d_dw); cudaFree(d_db); cudaFree(d_mean); cudaFree(d_rstd); cudaFree(d_scratch);
  std::vector<float> rdinp = to_f(dinp0), rdw = to_f(dw0), rdb = to_f(db0);
  std::vector<double> accw(C, 0), accb(C, 0);
  for (int i = 0; i < N; ++i) {
    const float* xi = &xf[(size_t)i * C];
    const float* di = &dof[(size_t)i * C];
    double dmean = 0, dnmean = 0;
    for (int c = 0; c < C; ++c) {
      float n = (xi[c] - mean[i]) * rstd[i];
      float dn = wf[c] * di[c];
      dmean += dn;
      dnmean += dn * n;
    }
    dmean /= C;
    dnmean /= C;
    for (int c = 0; c < C; ++c) {
      float n = (xi[c] - mean[i]) * rstd[i];
      accb[c] += di[c];
      accw[c] += n * di[c];
      float dval = (wf[c] * di[c] - (float)dmean - n * (float)dnmean) * rstd[i];
      rdinp[(size_t)i * C + c] += dval;
    }
  }
  for (int c = 0; c < C; ++c) {
    rdw[c] += (float)accw[c];
    rdb[c] += (float)accb[c];
  }
  // dweight and dbias sum N rows: scale the absolute tolerance with sqrt(N)
  float atol_sum = BF_ATOL * sqrtf((float)N);
  return close_bf(dinp, rdinp, NC, BF_RTOL, BF_ATOL).ok && close_bf(dw, rdw, C, BF_RTOL, atol_sum).ok && close_bf(db, rdb, C, BF_RTOL, atol_sum).ok;
}

static bool check_encoder_bwd(int B, int T, int C, int V, Rng& r) {
  int N = B * T;
  size_t NC = (size_t)N * C;
  std::vector<int> inp(N);
  for (auto& t : inp) t = r.range(0, V - 1);
  bfvec dout = rand_bf(NC, r, -1, 1), dwte0 = rand_bf((size_t)V * C, r, -0.5f, 0.5f), dwpe0 = rand_bf((size_t)T * C, r, -0.5f, 0.5f);
  int* d_inp = upT(inp);
  floatX *d_dout = up(dout), *d_dwte = up(dwte0), *d_dwpe = up(dwpe0);
  floatX* d_scratch = dmalloc<floatX>((size_t)B * T * 3 * C);
  int num_c_groups = CEIL_DIV(C, x128::size * WARP_SIZE);
  std::vector<int> workload((size_t)B * T * num_c_groups);
  std::vector<int4> buckets((size_t)B * T * num_c_groups);
  encoder_backward(d_dwte, d_dwpe, d_scratch, workload.data(), buckets.data(), d_dout, d_inp, inp.data(), B, T, C, 1234u, 0);
  cudaCheck(cudaDeviceSynchronize());
  bfvec dwte = down(d_dwte, (size_t)V * C), dwpe = down(d_dwpe, (size_t)T * C);
  cudaFree(d_inp); cudaFree(d_dout); cudaFree(d_dwte); cudaFree(d_dwpe); cudaFree(d_scratch);
  std::vector<double> aw((size_t)V * C, 0), ap((size_t)T * C, 0);
  std::vector<int> count(V, 0);
  for (int b = 0; b < B; ++b)
    for (int t = 0; t < T; ++t) {
      int ix = inp[b * T + t];
      count[ix]++;
      for (int c = 0; c < C; ++c) {
        float d = bf2f(dout[((size_t)b * T + t) * C + c]);
        aw[(size_t)ix * C + c] += d;
        ap[(size_t)t * C + c] += d;
      }
    }
  std::vector<float> rw = to_f(dwte0), rp = to_f(dwpe0);
  for (size_t i = 0; i < rw.size(); ++i) rw[i] += (float)aw[i];
  for (size_t i = 0; i < rp.size(); ++i) rp[i] += (float)ap[i];
  int maxc = *std::max_element(count.begin(), count.end());
  float atol_w = BF_ATOL * sqrtf((float)std::max(1, maxc)), atol_p = BF_ATOL * sqrtf((float)B);
  return close_bf(dwte, rw, rw.size(), BF_RTOL, atol_w).ok && close_bf(dwpe, rp, rp.size(), BF_RTOL, atol_p).ok;
}

// ------------------------------------------------------------------------------------------------
// modes

static int test_no = 0, failures = 0;
static void tap(bool ok, const std::string& name) {
  ++test_no;
  if (!ok) ++failures;
  printf("%s %d - %s\n", ok ? "ok" : "not ok", test_no, name.c_str());
  fflush(stdout);
}

static int run_tests() {
  printf("TAP version 13\n");
  Rng r(0x11c0ffeeULL);
  tap(check_encoder_fwd(4, 64, 768, 1024, r), "encoder_forward_B4_T64_C768");
  tap(check_encoder_fwd(1, 13, 64, 50, r), "encoder_forward_B1_T13_C64");
  tap(check_layernorm_fwd(4, 64, 768, r, false), "layernorm_forward_B4_T64_C768");
  tap(check_layernorm_fwd(2, 8, 1600, r, false), "layernorm_forward_B2_T8_C1600");
  tap(check_layernorm_fwd(1, 13, 768, r, false), "layernorm_forward_B1_T13_C768_values");
  tap(check_layernorm_fwd(1, 13, 768, r, true), "layernorm_forward_B1_T13_C768_guard_rows");
  tap(check_residual_fwd(65536, r), "residual_forward_N65536");
  tap(check_fused_residual_fwd(4, 64, 768, r, false), "fused_residual_forward_B4_T64_C768");
  tap(check_fused_residual_fwd(1, 13, 768, r, false), "fused_residual_forward_B1_T13_C768_values");
  tap(check_fused_residual_fwd(1, 13, 768, r, true), "fused_residual_forward_B1_T13_C768_guard_rows");
  tap(check_gelu_fwd(65536, r, 4.0f), "gelu_forward_N65536");
  tap(check_gelu_fwd(8192, r, 12.0f), "gelu_forward_N8192_wide_range");
  tap(check_gelu_bwd(65536, r, 4.0f), "gelu_backward_inplace_N65536");
  tap(check_layernorm_bwd(4, 64, 768, r), "layernorm_backward_B4_T64_C768");
  tap(check_layernorm_bwd(2, 32, 1024, r), "layernorm_backward_B2_T32_C1024");
  tap(check_encoder_bwd(4, 64, 768, 1024, r), "encoder_backward_B4_T64_C768_V1024");
  tap(check_encoder_bwd(2, 32, 256, 7, r), "encoder_backward_B2_T32_C256_V7_hot_tokens");
  printf("1..%d\n", test_no);
  return failures ? 1 : 0;
}

static int run_equiv(const char* seed) {
  Rng r(fnv1a(seed));
  const int Cs[] = {256, 384, 512, 768, 1024, 1280, 1600};
  auto pickC = [&]() { return Cs[r.range(0, 6)]; };
  for (int i = 0; i < 3; ++i) {
    int B = r.range(1, 4), T = 8 * r.range(1, 32), C = pickC(), V = r.range(2, 4096);
    printf("encoder_forward %dx%dx%d %s\n", B, T, C, check_encoder_fwd(B, T, C, V, r) ? "ok" : "FAIL");
  }
  for (int i = 0; i < 3; ++i) {
    int B = r.range(1, 4), T = 8 * r.range(1, 32), C = pickC();
    printf("layernorm_forward %dx%dx%d %s\n", B, T, C, check_layernorm_fwd(B, T, C, r, false) ? "ok" : "FAIL");
  }
  for (int i = 0; i < 3; ++i) {
    int B = r.range(1, 4), T = 8 * r.range(1, 32), C = pickC();
    printf("fused_residual_forward %dx%dx%d %s\n", B, T, C, check_fused_residual_fwd(B, T, C, r, false) ? "ok" : "FAIL");
  }
  for (int i = 0; i < 2; ++i) {
    int N = 2048 * r.range(1, 64);
    printf("residual_forward %d %s\n", N, check_residual_fwd(N, r) ? "ok" : "FAIL");
  }
  for (int i = 0; i < 2; ++i) {
    int N = 4096 * r.range(1, 32);
    printf("gelu_forward %d %s\n", N, check_gelu_fwd(N, r, r.uniform(1.0f, 12.0f)) ? "ok" : "FAIL");
    printf("gelu_backward_inplace %d %s\n", N, check_gelu_bwd(N, r, r.uniform(1.0f, 12.0f)) ? "ok" : "FAIL");
  }
  for (int i = 0; i < 2; ++i) {
    int B = r.range(1, 4), T = 8 * r.range(1, 16), C = pickC();
    printf("layernorm_backward %dx%dx%d %s\n", B, T, C, check_layernorm_bwd(B, T, C, r) ? "ok" : "FAIL");
  }
  for (int i = 0; i < 2; ++i) {
    int B = r.range(1, 4), T = 8 * r.range(1, 16), C = 256 * r.range(1, 6), V = r.range(2, 2048);
    printf("encoder_backward %dx%dx%d %s\n", B, T, C, check_encoder_bwd(B, T, C, V, r) ? "ok" : "FAIL");
  }
  return 0;
}

// GPT-2 small activations: B=8, T=1024, C=768, vocabulary 50257. The seed changes data only.
struct Bench {
  int B = 8, T = 1024, C = 768, V = 50257;
  int* inp = nullptr;
  floatX *a = nullptr, *b = nullptr, *w = nullptr, *bias = nullptr, *wte = nullptr, *wpe = nullptr, *out = nullptr, *out2 = nullptr, *big = nullptr, *big2 = nullptr;
  float *mean = nullptr, *rstd = nullptr;
  std::string kernel;
  Bench(const std::string& k, Rng& r) : kernel(k) {
    size_t NC = (size_t)B * T * C;
    if (k == "encoder_fwd") {
      std::vector<int> t(B * T);
      for (auto& x : t) x = r.range(0, V - 1);
      inp = upT(t);
      wte = up(rand_bf((size_t)V * C, r, -1, 1));
      wpe = up(rand_bf((size_t)T * C, r, -1, 1));
      out = dmalloc<floatX>(NC);
    } else if (k == "layernorm_fwd" || k == "fused_residual_fwd" || k == "residual_fwd") {
      a = up(rand_bf(NC, r, -2, 2));
      b = up(rand_bf(NC, r, -2, 2));
      w = up(rand_bf(C, r, -1, 1));
      bias = up(rand_bf(C, r, -1, 1));
      out = dmalloc<floatX>(NC);
      out2 = dmalloc<floatX>(NC);
      mean = dmalloc<float>(B * T);
      rstd = dmalloc<float>(B * T);
    } else if (k == "gelu_fwd" || k == "gelu_bwd") {
      size_t n = NC * 4;
      big = up(rand_bf(n, r, -4, 4));
      big2 = up(rand_bf(n, r, -1, 1));
    } else {
      fprintf(stderr, "unknown kernel %s\n", k.c_str());
      exit(2);
    }
  }
  void run() {
    int N = B * T, NC = B * T * C;
    if (kernel == "encoder_fwd") encoder_forward(out, inp, wte, wpe, B, T, C, 0);
    else if (kernel == "layernorm_fwd") layernorm_forward(out, mean, rstd, a, w, bias, B, T, C, 0);
    else if (kernel == "fused_residual_fwd") fused_residual_forward5(out, out2, mean, rstd, a, b, w, bias, N, C, 0);
    else if (kernel == "residual_fwd") residual_forward(out, a, b, NC, 0);
    else if (kernel == "gelu_fwd") gelu_forward(big2, big, NC * 4, 0);
    else if (kernel == "gelu_bwd") gelu_backward_inplace(big2, big, NC * 4, 0);
  }
};

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: lineage_harness test | equiv <seed> | bench|time <kernel> <seed>\n");
    return 2;
  }
  cudaCheck(cudaSetDevice(0));
  cudaCheck(cudaGetDeviceProperties(&deviceProp, 0));
  cudaCheck(cudaFree(0));
  std::string mode = argv[1];
  if (mode == "test") return run_tests();
  if (mode == "equiv" && argc >= 3) return run_equiv(argv[2]);
  if ((mode == "bench" || mode == "time") && argc >= 4) {
    Rng r(fnv1a(argv[3]));
    Bench bench(argv[2], r);
    cudaCheck(cudaDeviceSynchronize());
    if (mode == "bench") {
      bench.run();
      cudaCheck(cudaDeviceSynchronize());
      return 0;
    }
    const int warm = 5, reps = 50;
    std::vector<float> ms;
    cudaEvent_t e0, e1;
    cudaCheck(cudaEventCreate(&e0));
    cudaCheck(cudaEventCreate(&e1));
    for (int i = 0; i < warm + reps; ++i) {
      cudaCheck(cudaEventRecord(e0));
      bench.run();
      cudaCheck(cudaEventRecord(e1));
      cudaCheck(cudaEventSynchronize(e1));
      float t = 0;
      cudaCheck(cudaEventElapsedTime(&t, e0, e1));
      if (i >= warm) ms.push_back(t);
    }
    std::sort(ms.begin(), ms.end());
    printf("%.3f\n", ms[ms.size() / 2] * 1000.0f);
    return 0;
  }
  fprintf(stderr, "bad arguments\n");
  return 2;
}
