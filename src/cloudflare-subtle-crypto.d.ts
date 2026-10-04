/** Cloudflare Workers-specific constant-time byte comparison API. */
interface SubtleCrypto {
  /** Compare equal-length buffers without data-dependent early exit. */
  timingSafeEqual: (first: BufferSource, second: BufferSource) => boolean;
}
