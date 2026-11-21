#!/usr/bin/env bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
#
# This source code is licensed under the MIT license found in the
# LICENSE file in the root directory of this source tree.
#
# Regenerates the decode fixtures with ffmpeg (libmp3lame, libvorbis, aac, flac, libopus).
# Signal: 1 s, left 440 Hz, right 660 Hz (mono files: 440 Hz), amplitude 0.5.
set -euo pipefail
cd "$(dirname "$0")"
gen() { # rate channels
  if [ "$2" = 2 ]; then
    echo "-f lavfi -i sine=frequency=440:sample_rate=$1:duration=1 -f lavfi -i sine=frequency=660:sample_rate=$1:duration=1 -filter_complex [0:a][1:a]amerge=inputs=2,volume=4.0[a] -map [a]"
  else
    echo "-f lavfi -i sine=frequency=440:sample_rate=$1:duration=1 -filter_complex [0:a]volume=4.0[a] -map [a]"
  fi
}
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
ff $(gen 44100 2) -c:a libmp3lame -b:a 192k mp3-44100-stereo-cbr.mp3
ff $(gen 22050 1) -c:a libmp3lame -q:a 2 mp3-22050-mono-vbr.mp3
ff $(gen 48000 2) -c:a libmp3lame -q:a 0 -id3v2_version 3 -metadata title=fixture mp3-48000-stereo-vbr-id3.mp3
ff $(gen 44100 2) -c:a libvorbis -q:a 6 vorbis-44100-stereo.ogg
ff $(gen 48000 1) -c:a libvorbis -q:a 6 vorbis-48000-mono.ogg
ff $(gen 22050 1) -c:a libvorbis -q:a 6 vorbis-22050-mono.ogg
ff $(gen 22050 1) -t 0.25 -c:a pcm_s16le wav-22050-mono-s16.wav
ff $(gen 44100 2) -t 0.25 -c:a pcm_s24le wav-44100-stereo-s24.wav
ff $(gen 48000 2) -t 0.25 -c:a pcm_f32le wav-48000-stereo-f32.wav
ff $(gen 44100 2) -c:a aac -b:a 128k aac-44100-stereo.m4a
ff $(gen 44100 2) -c:a flac flac-44100-stereo.flac
ff $(gen 48000 2) -c:a libopus -b:a 96k opus-48000-stereo.ogg
python3 -I -c "import random,sys; random.seed(7); sys.stdout.buffer.write(bytes(random.randrange(256) for _ in range(4000)))" > garbage.mp3
printf '<html><body>404 Not Found</body></html>' > html-404.mp3
ls -la
