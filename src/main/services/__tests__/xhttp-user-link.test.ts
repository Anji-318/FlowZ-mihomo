import { ProtocolParser } from '../ProtocolParser';

test('用户提供的 xhttp 分享链接可解析', () => {
  const parser = new ProtocolParser();
  const url =
    'vless://30f08a7b-aeee-4685-bbec-ba9eed41579b@43.207.38.150:49158?encryption=none&security=tls&sni=13.baiduyun13.ccwu.cc&fp=chrome&alpn=h2%2Chttp%2F1.1&insecure=0&allowInsecure=0&type=xhttp&host=13.baiduyun13.ccwu.cc&path=%2Fspeed%3D107.148.118.151&mode=stream-one#%F0%9F%87%AF%F0%9F%87%B5%E6%97%A5%E6%9C%AC-21';
  const s = parser.parseUrl(url);
  expect(s.protocol).toBe('vless');
  expect(s.address).toBe('43.207.38.150');
  expect(s.port).toBe(49158);
  expect(s.network).toBe('xhttp');
  expect(s.security).toBe('tls');
  expect(s.tlsSettings?.serverName).toBe('13.baiduyun13.ccwu.cc');
  expect(s.xhttpSettings?.host).toBe('13.baiduyun13.ccwu.cc');
  expect(s.xhttpSettings?.path).toBe('/speed=107.148.118.151');
  expect(s.xhttpSettings?.mode).toBe('stream-one');
});
