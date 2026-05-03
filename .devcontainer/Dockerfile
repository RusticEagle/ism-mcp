FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

# Install additional tools
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    vim \
    curl \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Install AI Skills
## Merill Microsoft Graph Skill
# RUN npx skills add merill/msgraph
# ## NextJS AI Skill
# RUN npm install @vercel/next-skills


# Set up workspace
WORKDIR /workspace

# Install global npm packages for development
RUN npm install -g npm@latest

# Set environment variables
ENV NODE_ENV=development