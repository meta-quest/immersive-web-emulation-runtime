// Copyright (c) Meta Platforms, Inc. and affiliates.
//
// This source code is licensed under the MIT license found in the
// LICENSE file in the root directory of this source tree.
//
// Connector over the Android platform's own sockets and TLS (java.net.Socket,
// javax.net.ssl.SSLSocketFactory.getDefault() = Conscrypt with the system
// trust store and the app's network security config), called through JNI.
// Only platform classes are used, so no app dex code is required: FindClass
// works from any attached native thread for boot-classpath classes.
//
// What it does per connection (NET-6):
//  - proxy: java.net.ProxySelector.getDefault().select(URI) — the system /
//    Wi-Fi proxy; HTTP proxies are tunnelled with CONNECT (loopback is
//    never proxied);
//  - TCP: Socket.connect(InetSocketAddress, timeout), TCP_NODELAY;
//  - TLS: SSLSocketFactory.createSocket(socket, host, port, true) (SNI from
//    host), SSLParameters.setEndpointIdentificationAlgorithm("HTTPS"),
//    startHandshake(), then HttpsURLConnection.getDefaultHostnameVerifier()
//    .verify(host, session) as Android's docs recommend for raw SSLSockets.
//    A certificate the system store rejects fails with NetErrorKind::kTls.

#ifndef IWN_NET_JNI_CONNECTOR_H_
#define IWN_NET_JNI_CONNECTOR_H_

#include <jni.h>

#include <memory>

#include "iwn/net/stream.h"

namespace iwn::net {

// Call once (any thread) before connecting. Keeps a reference to the VM only.
bool InitJniNet(JavaVM* vm);

std::unique_ptr<Connector> MakeJniConnector();

}  // namespace iwn::net

#endif  // IWN_NET_JNI_CONNECTOR_H_
