#Start the image with a node base image
FROM node:24-alpine

#The /app directory should act as the main application directory
WORKDIR /app

#Copy the app package and package-lock.json file
COPY package*.json ./

#Install what's locked in package-lock.json
RUN npm ci

#Copy everything from the build context (excluding anything in .dockerignore)
#into the current WORKDIR (/app) inside the image being built
COPY . .

#Document which port the app listens on internally, metadata only
EXPOSE 3000

#The command runc will exec()
CMD ["node", "server.js"]