/**
 * dockerfileGenerator.js
 *
 * Generates an nsjail-enabled Dockerfile for supported language runtimes.
 * Follows the standard pattern used by existing working Dockerfiles.
 */

const KNOWN_LANGUAGES = {
  python: {
    baseImage: 'python:3.12',
    extraPackages: []
  },
  javascript: {
    baseImage: 'node:20',
    extraPackages: []
  },
  node: {
    baseImage: 'node:20',
    extraPackages: []
  },
  java: {
    baseImage: 'eclipse-temurin:21',
    extraPackages: []
  },
  c: {
    baseImage: 'gcc:12',
    extraPackages: []
  },
  cpp: {
    baseImage: 'gcc:12',
    extraPackages: []
  },
  go: {
    baseImage: 'golang:1.22',
    extraPackages: []
  },
  rust: {
    baseImage: 'rust:latest',
    extraPackages: []
  },
  ruby: {
    baseImage: 'ruby:3.3',
    extraPackages: []
  },
  php: {
    baseImage: 'php:8.3-cli',
    extraPackages: []
  }
};

/**
 * Generates Dockerfile content with NSJail setup.
 *
 * @param {string} language
 * @param {string} [customBaseImage]
 * @returns {string}
 */
function generateDockerfile(language, customBaseImage) {
  const normLang = language.toLowerCase();
  const langConfig = KNOWN_LANGUAGES[normLang] || {
    baseImage: customBaseImage || 'ubuntu:22.04',
    extraPackages: []
  };

  const baseImage = customBaseImage || langConfig.baseImage;
  const extraPkgs = langConfig.extraPackages.join(' ');
  const installExtra = extraPkgs ? ` ${extraPkgs}` : '';

  return `FROM ${baseImage}

RUN apt-get update && apt-get install -y \\
    autoconf \\
    bison \\
    flex \\
    gcc \\
    g++ \\
    git \\
    libprotobuf-dev \\
    libnl-route-3-dev \\
    libtool \\
    make \\
    pkg-config \\
    protobuf-compiler${installExtra}

RUN git clone https://github.com/google/nsjail.git /opt/nsjail && \\
    cd /opt/nsjail && \\
    make

WORKDIR /workspace
`;
}

module.exports = {
  generateDockerfile,
  KNOWN_LANGUAGES
};
