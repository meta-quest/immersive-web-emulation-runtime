// Reference JPEG decoding/encoding with libjpeg-turbo (test-only; the decoder behind Skia / AImageDecoder and
// Chromium). Defaults as those decoders use them: JDCT_ISLOW, fancy upsampling on.
#include "jpeg_ref.h"

#include <csetjmp>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#if IWN_IMAGE_HAVE_LIBJPEG_REF
extern "C" {
#include "jpeglib.h"
}
#endif

namespace iwn::image::test {

#if IWN_IMAGE_HAVE_LIBJPEG_REF
namespace {

struct ErrorManager {
  jpeg_error_mgr pub;
  std::jmp_buf jump;
};

void OnError(j_common_ptr cinfo) {
  auto* err = reinterpret_cast<ErrorManager*>(cinfo->err);
  std::longjmp(err->jump, 1);
}

void Silence(j_common_ptr, int) {}

// Decodes to `out_space` with `components` per pixel.
bool DecodeTo(const Bytes& jpeg, J_COLOR_SPACE out_space, int components, uint32_t* w, uint32_t* h,
              std::vector<uint8_t>* out) {
  jpeg_decompress_struct cinfo;
  ErrorManager err;
  cinfo.err = jpeg_std_error(&err.pub);
  err.pub.error_exit = OnError;
  err.pub.emit_message = Silence;
  if (setjmp(err.jump)) {
    jpeg_destroy_decompress(&cinfo);
    return false;
  }
  jpeg_create_decompress(&cinfo);
  jpeg_mem_src(&cinfo, jpeg.data(), static_cast<unsigned long>(jpeg.size()));
  if (jpeg_read_header(&cinfo, TRUE) != JPEG_HEADER_OK) {
    jpeg_destroy_decompress(&cinfo);
    return false;
  }
  cinfo.out_color_space = out_space;
  cinfo.dct_method = JDCT_ISLOW;
  cinfo.do_fancy_upsampling = TRUE;
  jpeg_start_decompress(&cinfo);
  *w = cinfo.output_width;
  *h = cinfo.output_height;
  out->assign(size_t{*w} * *h * components, 0);
  while (cinfo.output_scanline < cinfo.output_height) {
    JSAMPROW row = out->data() + size_t{cinfo.output_scanline} * *w * components;
    jpeg_read_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);
  return true;
}

}  // namespace

bool HaveLibjpegReference() { return true; }

bool LibjpegDecodeRgba(const Bytes& jpeg, Img* out) {
  std::vector<uint8_t> px;
  if (!DecodeTo(jpeg, JCS_EXT_RGBA, 4, &out->w, &out->h, &px)) return false;
  out->rgba = std::move(px);
  return true;
}

bool LibjpegDecodeCmyk(const Bytes& jpeg, uint32_t* w, uint32_t* h, std::vector<uint8_t>* cmyk) {
  return DecodeTo(jpeg, JCS_CMYK, 4, w, h, cmyk);
}

Bytes LibjpegEncodeCmyk(uint32_t w, uint32_t h, const std::vector<uint8_t>& cmyk, int quality, bool ycck) {
  jpeg_compress_struct cinfo;
  ErrorManager err;
  cinfo.err = jpeg_std_error(&err.pub);
  err.pub.error_exit = OnError;
  err.pub.emit_message = Silence;
  unsigned char* buf = nullptr;
  unsigned long size = 0;
  if (setjmp(err.jump)) {
    jpeg_destroy_compress(&cinfo);
    std::free(buf);
    return {};
  }
  jpeg_create_compress(&cinfo);
  jpeg_mem_dest(&cinfo, &buf, &size);
  cinfo.image_width = w;
  cinfo.image_height = h;
  cinfo.input_components = 4;
  cinfo.in_color_space = JCS_CMYK;
  jpeg_set_defaults(&cinfo);
  jpeg_set_colorspace(&cinfo, ycck ? JCS_YCCK : JCS_CMYK);  // both write an Adobe APP14 marker
  jpeg_set_quality(&cinfo, quality, TRUE);
  for (int i = 0; i < cinfo.num_components; ++i) {  // no chroma subsampling: keep the test about colour conversion
    cinfo.comp_info[i].h_samp_factor = 1;
    cinfo.comp_info[i].v_samp_factor = 1;
  }
  jpeg_start_compress(&cinfo, TRUE);
  while (cinfo.next_scanline < cinfo.image_height) {
    JSAMPROW row = const_cast<uint8_t*>(cmyk.data()) + size_t{cinfo.next_scanline} * w * 4;
    jpeg_write_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_compress(&cinfo);
  jpeg_destroy_compress(&cinfo);
  Bytes out(buf, buf + size);
  std::free(buf);
  return out;
}

Bytes LibjpegEncodeFlat(uint32_t w, uint32_t h, int components, uint8_t value, int quality, bool progressive) {
  jpeg_compress_struct cinfo;
  ErrorManager err;
  cinfo.err = jpeg_std_error(&err.pub);
  err.pub.error_exit = OnError;
  err.pub.emit_message = Silence;
  unsigned char* buf = nullptr;
  unsigned long size = 0;
  std::vector<uint8_t> row(size_t{w} * components, value);
  if (setjmp(err.jump)) {
    jpeg_destroy_compress(&cinfo);
    std::free(buf);
    return {};
  }
  jpeg_create_compress(&cinfo);
  jpeg_mem_dest(&cinfo, &buf, &size);
  cinfo.image_width = w;
  cinfo.image_height = h;
  cinfo.input_components = components;
  cinfo.in_color_space = components == 1 ? JCS_GRAYSCALE : JCS_RGB;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, quality, TRUE);
  cinfo.optimize_coding = TRUE;
  if (progressive) jpeg_simple_progression(&cinfo);
  jpeg_start_compress(&cinfo, TRUE);
  while (cinfo.next_scanline < cinfo.image_height) {
    JSAMPROW r = row.data();
    jpeg_write_scanlines(&cinfo, &r, 1);
  }
  jpeg_finish_compress(&cinfo);
  jpeg_destroy_compress(&cinfo);
  Bytes out(buf, buf + size);
  std::free(buf);
  return out;
}
#else
bool HaveLibjpegReference() { return false; }
bool LibjpegDecodeRgba(const Bytes&, Img*) { return false; }
bool LibjpegDecodeCmyk(const Bytes&, uint32_t*, uint32_t*, std::vector<uint8_t>*) { return false; }
Bytes LibjpegEncodeCmyk(uint32_t, uint32_t, const std::vector<uint8_t>&, int, bool) { return {}; }
Bytes LibjpegEncodeFlat(uint32_t, uint32_t, int, uint8_t, int, bool) { return {}; }
#endif

}  // namespace iwn::image::test
