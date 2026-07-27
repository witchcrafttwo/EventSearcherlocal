import json
import os

import boto3


bedrock = boto3.client("bedrock-runtime")


def handler(event, _context):
    response = bedrock.converse(
        modelId=os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-haiku-20240307-v1:0"),
        messages=[
            {
                "role": "user",
                "content": [{"text": build_prompt(event)}],
            }
        ],
        inferenceConfig={
            "maxTokens": 800,
            "temperature": 0.1,
        },
    )
    text = "\n".join(part.get("text", "") for part in response["output"]["message"]["content"])
    return json.loads(extract_json(text))


def build_prompt(candidate):
    return "\n".join(
        [
            "以下の地域イベント候補を、子ども向けレジャー通知アプリ用にJSONだけで整理してください。",
            "不明な項目は省略し、誇張せず、本文にない情報は作らないでください。",
            "",
            "JSON schema:",
            '{"title":"string","summary":"string","eventDate":"YYYY-MM-DD","targetAgeMin":number,"targetAgeMax":number,"interests":["string"]}',
            "",
            f"source: {candidate.get('sourceName', '')}",
            f"area: {candidate.get('area', '')}",
            f"title: {candidate.get('title', '')}",
            f"url: {candidate.get('url', '')}",
            f"snippet: {candidate.get('snippet', '')}",
        ]
    )


def extract_json(text):
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object in model response")
    return text[start : end + 1]
