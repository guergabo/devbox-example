# The environment every agent devbox starts from. `npm run add-customer`
# builds it inside each customer's tenant.
FROM node:22-bookworm

# tmux runs the blueprint's sessions; sudo matches Namespace's base images.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y \
	git tmux sudo curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& echo "node ALL=(ALL:ALL) NOPASSWD:ALL" > /etc/sudoers.d/node \
	&& chmod 0440 /etc/sudoers.d/node

# An empty repository for the agent to work in. The initial commit gives
# Amp's Changes tab something to diff against.
RUN mkdir -p /workspace/project && chown -R node:node /workspace
USER node
WORKDIR /workspace/project
RUN git init -q \
	&& git -c user.name=my-platform-devbox -c user.email=my-platform-devbox@example.com commit -q --allow-empty -m "Empty project"

# The Amp CLI installs into ~/.amp/bin, where a runner can update itself.
# Link it onto the default PATH so services and `devbox exec` find it.
RUN curl -fsSL https://ampcode.com/install.sh | bash \
	&& sudo ln -sf /home/node/.amp/bin/amp /usr/local/bin/amp
