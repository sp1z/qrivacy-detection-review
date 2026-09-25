import { config } from "../config.js";
import type { Connector, Platform } from "./types.js";
import { blueskyConnector } from "./bluesky.js";
import { redditConnector } from "./reddit.js";
import { mastodonConnector } from "./mastodon.js";
import { xConnector } from "./x.js";
import { instagramConnector } from "./instagram.js";
import { facebookConnector } from "./facebook.js";
import { linkedinConnector } from "./linkedin.js";
import { tiktokConnector } from "./tiktok.js";
import { youtubeConnector } from "./youtube.js";
import { dailymotionConnector } from "./dailymotion.js";
import { lemmyConnector } from "./lemmy.js";
import { peertubeConnector } from "./peertube.js";
import { webConnector } from "./web.js";
import { flickrConnector } from "./flickr.js";
import { vimeoConnector } from "./vimeo.js";

const ALL: Record<Platform, Connector> = {
  bluesky: blueskyConnector,
  reddit: redditConnector,
  mastodon: mastodonConnector,
  x: xConnector,
  instagram: instagramConnector,
  facebook: facebookConnector,
  linkedin: linkedinConnector,
  tiktok: tiktokConnector,
  youtube: youtubeConnector,
  dailymotion: dailymotionConnector,
  lemmy: lemmyConnector,
  peertube: peertubeConnector,
  web: webConnector,
  flickr: flickrConnector,
  vimeo: vimeoConnector,
};

/** Connectors turned on via ENABLED_CONNECTORS. */
export function enabledConnectors(): Connector[] {
  return config.enabledConnectors
    .map((p) => ALL[p])
    .filter((c): c is Connector => Boolean(c));
}

export function connectorFor(platform: string): Connector | null {
  return (ALL as Record<string, Connector>)[platform] ?? null;
}

export { ALL as allConnectors };
