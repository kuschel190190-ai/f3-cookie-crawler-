# F3 Dashboard – nginx + Env-Config
FROM nginx:alpine

# Git-Commit wird von Coolify als SOURCE_COMMIT übergeben
ARG SOURCE_COMMIT=unknown
ENV GIT_COMMIT=${SOURCE_COMMIT}

COPY nginx/nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html /usr/share/nginx/html/
COPY css/       /usr/share/nginx/html/css/
COPY js/        /usr/share/nginx/html/js/
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80
CMD ["/entrypoint.sh"]
