# The devbox image every arena contestant starts from. Build it from the
# repository root, so the sample app is in the build context:
#
#   devbox image build . --name arena-runner -f image/Dockerfile --workspace_dir /workspace
FROM node:22-bookworm

# tmux runs the blueprint's sessions; sudo matches Namespace's base images.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
	git tmux sudo ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& echo "node ALL=(ALL:ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
	&& chmod 0440 /etc/sudoers.d/node

RUN npm install -g @anthropic-ai/claude-code

# The network policy only allows what the agent needs, so turn off Claude
# Code's optional telemetry and auto-updates.
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
	DISABLE_AUTOUPDATER=1

COPY image/arena-agent /usr/local/bin/arena-agent

# The sample app, with dependencies installed and a baseline commit, so each
# contestant's changes show up in `git diff`.
COPY --chown=node:node sample-app /workspace/app
RUN chown node:node /workspace
USER node
WORKDIR /workspace/app
RUN npm ci \
	&& git init -q \
	&& git add -A \
	&& git -c user.name=arena -c user.email=arena@example.com commit -qm "Sample app"
