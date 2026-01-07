/**
 * Web Fetch Special Handlers Index
 *
 * Exports all special handlers for site-specific content extraction.
 */

export { handleArtifactHub } from "./artifacthub";
// Academic
export { handleArxiv } from "./arxiv";
export { handleAur } from "./aur";
export { handleBiorxiv } from "./biorxiv";
export { handleBluesky } from "./bluesky";
export { handleBrew } from "./brew";
export { handleCheatSh } from "./cheatsh";
export { handleChocolatey } from "./chocolatey";
export { handleCoinGecko } from "./coingecko";
export { handleCratesIo } from "./crates-io";
export { handleDevTo } from "./devto";
export { handleDiscogs } from "./discogs";
export { handleDockerHub } from "./dockerhub";
// Git hosting
export { fetchGitHubApi, handleGitHub } from "./github";
export { handleGitHubGist } from "./github-gist";
export { handleGitLab } from "./gitlab";
export { handleGoPkg } from "./go-pkg";
export { handleHackage } from "./hackage";
export { handleHackerNews } from "./hackernews";
export { handleHex } from "./hex";
// ML/AI
export { handleHuggingFace } from "./huggingface";
export { handleIacr } from "./iacr";
export { handleLobsters } from "./lobsters";
export { handleMastodon } from "./mastodon";
export { handleMaven } from "./maven";
export { handleMDN } from "./mdn";
export { handleMetaCPAN } from "./metacpan";
// Package registries
export { handleNpm } from "./npm";
export { handleNuGet } from "./nuget";
export { handleNvd } from "./nvd";
export { handleOpenCorporates } from "./opencorporates";
export { handleOpenLibrary } from "./openlibrary";
export { handleOsv } from "./osv";
export { handlePackagist } from "./packagist";
export { handlePubDev } from "./pub-dev";
export { handlePubMed } from "./pubmed";
export { handlePyPI } from "./pypi";
export { handleReadTheDocs } from "./readthedocs";
export { handleReddit } from "./reddit";
export { handleRepology } from "./repology";
export { handleRfc } from "./rfc";
export { handleRubyGems } from "./rubygems";
export { handleSecEdgar } from "./sec-edgar";
export { handleSemanticScholar } from "./semantic-scholar";
export { handleSpotify } from "./spotify";
// Developer content
export { handleStackOverflow } from "./stackoverflow";
export { handleTerraform } from "./terraform";
export { handleTldr } from "./tldr";
// Social/News
export { handleTwitter } from "./twitter";
export type { RenderResult, SpecialHandler } from "./types";
export { handleVimeo } from "./vimeo";

// Reference
export { handleWikidata } from "./wikidata";
export { handleWikipedia } from "./wikipedia";
// Video/Media
export { handleYouTube } from "./youtube";
