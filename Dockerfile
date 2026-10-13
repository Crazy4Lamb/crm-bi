FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml ./
COPY src ./src
COPY web ./web
RUN --mount=type=cache,target=/root/.m2 mvn -B -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
RUN useradd --system --uid 10001 --create-home crm
COPY --from=build /workspace/target/crm-bi-*.jar /app/crm-bi.jar
USER crm
EXPOSE 8787
ENTRYPOINT ["java","-XX:MaxRAMPercentage=75.0","-jar","/app/crm-bi.jar"]
