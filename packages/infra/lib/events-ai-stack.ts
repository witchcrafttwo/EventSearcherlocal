import { CfnOutput, RemovalPolicy, Stack, StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Instance, InstanceClass, InstanceSize, InstanceType, KeyPair, MachineImage, Peer, Port, SecurityGroup, SubnetType, UserData, Vpc } from "aws-cdk-lib/aws-ec2";
import { Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { Secret } from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class EventsAiStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const profilesTable = new Table(this, "ProfilesTable", {
      partitionKey: { name: "profileId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const eventsTable = new Table(this, "EventsTable", {
      partitionKey: { name: "eventId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN
    });
    eventsTable.addGlobalSecondaryIndex({
      indexName: "publishedAtIndex",
      partitionKey: { name: "eventType", type: AttributeType.STRING },
      sortKey: { name: "publishedAt", type: AttributeType.STRING }
    });

    const subscriptionsTable = new Table(this, "SubscriptionsTable", {
      partitionKey: { name: "profileId", type: AttributeType.STRING },
      sortKey: { name: "endpointHash", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN
    });

    const vpc = new Vpc(this, "EventsVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: SubnetType.PUBLIC
        }
      ]
    });

    const securityGroup = new SecurityGroup(this, "WebSecurityGroup", {
      vpc,
      allowAllOutbound: true,
      description: "Allow public HTTP traffic to the EC2 web server"
    });
    securityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), "HTTP");

    const sshCidr = process.env.EC2_SSH_CIDR;
    if (sshCidr) {
      securityGroup.addIngressRule(Peer.ipv4(sshCidr), Port.tcp(22), "SSH");
    }

    const role = new Role(this, "WebServerRole", {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")]
    });
    profilesTable.grantReadWriteData(role);
    eventsTable.grantReadWriteData(role);
    subscriptionsTable.grantReadWriteData(role);
    role.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
        resources: ["*"]
      })
    );

    const openAiSecretName = process.env.OPENAI_API_KEY_SECRET_NAME;
    if (openAiSecretName) {
      Secret.fromSecretNameV2(this, "OpenAiApiKeySecret", openAiSecretName).grantRead(role);
    }

    const appAsset = new Asset(this, "ApplicationSource", {
      path: join(__dirname, "../../.."),
      exclude: [
        "node_modules",
        "packages/*/node_modules",
        "packages/infra/cdk.out",
        "packages/web/dist",
        ".env",
        ".env.*",
        ".git"
      ]
    });
    appAsset.grantRead(role);

    const userData = UserData.forLinux();
    userData.addCommands(
      "set -eux",
      "dnf update -y",
      "dnf install -y unzip curl",
      "curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -",
      "dnf install -y nodejs",
      "mkdir -p /opt/prefecture-events-ai",
      `aws s3 cp "s3://${appAsset.s3BucketName}/${appAsset.s3ObjectKey}" /tmp/prefecture-events-ai.zip`,
      "unzip -q /tmp/prefecture-events-ai.zip -d /opt/prefecture-events-ai",
      "cd /opt/prefecture-events-ai",
      "npm ci",
      "npm run build",
      "cat > /etc/prefecture-events-ai.env <<'EOF'",
      "PORT=80",
      `PROFILES_TABLE=${profilesTable.tableName}`,
      `EVENTS_TABLE=${eventsTable.tableName}`,
      `SUBSCRIPTIONS_TABLE=${subscriptionsTable.tableName}`,
      `VAPID_PUBLIC_KEY=${process.env.VAPID_PUBLIC_KEY ?? ""}`,
      `VAPID_PRIVATE_KEY=${process.env.VAPID_PRIVATE_KEY ?? ""}`,
      `VAPID_SUBJECT=${process.env.VAPID_SUBJECT ?? "mailto:admin@example.com"}`,
      `AI_PROVIDER=${process.env.AI_PROVIDER ?? "openai"}`,
      `OPENAI_API_KEY_SECRET_NAME=${process.env.OPENAI_API_KEY_SECRET_NAME ?? ""}`,
      `OPENAI_MODEL=${process.env.OPENAI_MODEL ?? "gpt-5.5"}`,
      `BEDROCK_MODEL_ID=${process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-3-haiku-20240307-v1:0"}`,
      `AI_LANGUAGE=${process.env.AI_LANGUAGE ?? "typescript"}`,
      `EVENT_SOURCES_JSON_BASE64=${Buffer.from(process.env.EVENT_SOURCES_JSON ?? "[]", "utf8").toString("base64")}`,
      `INGEST_INTERVAL_MINUTES=${process.env.INGEST_INTERVAL_MINUTES ?? "360"}`,
      "WEB_DIST_DIR=/opt/prefecture-events-ai/packages/web/dist",
      "EOF",
      "cat > /etc/systemd/system/prefecture-events-ai.service <<'EOF'",
      "[Unit]",
      "Description=Prefecture Events AI web server",
      "After=network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "WorkingDirectory=/opt/prefecture-events-ai",
      "EnvironmentFile=/etc/prefecture-events-ai.env",
      "ExecStart=/usr/bin/npm --workspace @prefecture-events-ai/server run start",
      "Restart=always",
      "RestartSec=5",
      "User=root",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
      "EOF",
      "systemctl daemon-reload",
      "systemctl enable --now prefecture-events-ai.service"
    );

    const instance = new Instance(this, "WebServerInstance", {
      vpc,
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      securityGroup,
      role,
      instanceType: instanceTypeFromEnv(),
      machineImage: MachineImage.latestAmazonLinux2023(),
      userData,
      keyPair: process.env.EC2_KEY_NAME ? KeyPair.fromKeyPairName(this, "ImportedKeyPair", process.env.EC2_KEY_NAME) : undefined
    });

    new CfnOutput(this, "WebServerPublicIp", { value: instance.instancePublicIp });
    new CfnOutput(this, "WebUrl", { value: `http://${instance.instancePublicDnsName}` });
    new CfnOutput(this, "SsmConnectHint", {
      value: `aws ssm start-session --target ${instance.instanceId}`
    });
  }
}

function instanceTypeFromEnv(): InstanceType {
  const value = process.env.EC2_INSTANCE_TYPE ?? "t3.micro";
  const [instanceClass, instanceSize] = value.split(".");
  if (!instanceClass || !instanceSize) {
    return InstanceType.of(InstanceClass.T3, InstanceSize.MICRO);
  }
  return new InstanceType(`${instanceClass}.${instanceSize}`);
}
