const base = (process.env.CLIENT_BASE_PATH || '').replace(/\/+$/, '');
const logo = `${base}/portal/vnet-photo-20261012/panorama-assistant.51a26c035165.webp`;

export function PanoramaAssistantLogo() {
  return <img className="panorama-assistant-logo" src={logo} width={128} height={128} alt="" aria-hidden="true" decoding="async" />;
}
