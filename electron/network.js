/**
 * 局域网地址工具
 */

import os from 'os';

/**
 * 列出可用的局域网 IPv4 地址
 * 过滤回环、169.254 链路本地、以及 Docker/虚拟网卡常见网段
 */
export const listLanAddresses = () => {
  const result = [];
  const ifaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('169.254.')) continue;

      result.push({
        name,
        address: addr.address,
        // 虚拟网卡优先级降低，Windows 上常见于 WSL / VirtualBox / Docker
        virtual: /vEthernet|VirtualBox|VMware|Hyper-V|docker|br-|veth|WSL/i.test(name)
      });
    }
  }

  // 物理网卡优先
  result.sort((a, b) => Number(a.virtual) - Number(b.virtual));
  return result;
};

/**
 * 挑选最可能的局域网地址（首选非虚拟网卡 + 常见私网网段）
 */
export const pickPrimaryAddress = () => {
  const list = listLanAddresses();
  if (list.length === 0) return null;

  const privateRe = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/;
  const preferred = list.find((item) => !item.virtual && privateRe.test(item.address));
  return preferred || list.find((item) => privateRe.test(item.address)) || list[0];
};
