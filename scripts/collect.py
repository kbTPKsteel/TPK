#!/usr/bin/env python3
import os, json, yaml, base64, subprocess
from pathlib import Path
from datetime import datetime, timezone
import requests

CENTRAL_REPO = "kbTPKsteel/TPK"
CATALOG_FILE = Path("catalog.json")
REPOS_FILE = Path("repos.yml")
IMAGES_DIR = Path("docs/images")


def api_get(url, token):
    r = requests.get(url, headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json"
    })
    r.raise_for_status()
    return r.json()


def api_post(url, token, data):
    return requests.post(url, headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json"
    }, json=data)


def download_asset(url, token, dest_path):
    r = requests.get(url, headers={
        "Authorization": f"token {token}",
        "Accept": "application/octet-stream"
    }, stream=True)
    r.raise_for_status()
    with open(dest_path, "wb") as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)


def get_file_from_repo(repo, path, token):
    data = api_get(f"https://api.github.com/repos/{repo}/contents/{path}", token)
    return base64.b64decode(data["content"])


def ensure_central_release(tag, name, central_token):
    try:
        return api_get(
            f"https://api.github.com/repos/{CENTRAL_REPO}/releases/tags/{tag}",
            central_token
        )
    except requests.HTTPError:
        r = api_post(
            f"https://api.github.com/repos/{CENTRAL_REPO}/releases",
            central_token,
            {"tag_name": tag, "name": name, "draft": False, "prerelease": False}
        )
        return r.json()


def upload_to_release(tag, file_path, central_token):
    subprocess.run([
        "gh", "release", "upload", tag,
        str(file_path), "--clobber",
        f"--repo={CENTRAL_REPO}"
    ], env={**os.environ, "GH_TOKEN": central_token}, check=True)


def main():
    central_token = os.environ["GH_TOKEN"]
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    with open(REPOS_FILE) as f:
        config = yaml.safe_load(f)

    catalog = json.loads(CATALOG_FILE.read_text()) if CATALOG_FILE.exists() else {"products": []}
    products = {p["id"]: p for p in catalog.get("products", [])}

    for source in config["sources"]:
        repo = source["repo"]
        token = os.environ.get(source["token_secret"], "")
        if not token:
            print(f"SKIP {repo}: токен не найден ({source['token_secret']})")
            continue

        print(f"\nОбрабатываем {repo}...")

        # Читаем catalog.yml
        try:
            meta = yaml.safe_load(get_file_from_repo(repo, "catalog.yml", token))
        except Exception as e:
            print(f"  ОШИБКА: не удалось прочитать catalog.yml: {e}")
            continue

        product_id = repo.replace("/", "-")
        owner = repo.split("/")[0]

        # Скачиваем картинку из приватного репо и кладём в docs/images/
        image_url = None
        img_val = meta.get("image", "")
        if img_val.startswith("http"):
            image_url = img_val
        elif img_val:
            try:
                img_ext = Path(img_val).suffix
                img_dest = IMAGES_DIR / f"{product_id}{img_ext}"
                img_data = get_file_from_repo(repo, img_val, token)
                img_dest.write_bytes(img_data)
                image_url = f"https://raw.githubusercontent.com/{CENTRAL_REPO}/main/docs/images/{product_id}{img_ext}"
                print(f"  Картинка сохранена: {img_dest}")
            except Exception as e:
                print(f"  ПРЕДУПРЕЖДЕНИЕ: не удалось получить картинку: {e}")

        # Собираем релизы
        releases = api_get(f"https://api.github.com/repos/{repo}/releases", token)
        versions = []

        for release in releases:
            tag = release["tag_name"]
            central_tag = f"{product_id}-{tag}"
            assets_info = []

            if release.get("assets"):
                ensure_central_release(central_tag, f"{meta['name']} {tag}", central_token)

                for asset in release["assets"]:
                    tmp_path = Path(f"/tmp/{asset['name']}")
                    try:
                        download_asset(asset["url"], token, tmp_path)
                        upload_to_release(central_tag, tmp_path, central_token)
                        assets_info.append({
                            "name": asset["name"],
                            "downloadUrl": f"https://github.com/{CENTRAL_REPO}/releases/download/{central_tag}/{asset['name']}",
                            "size": asset["size"]
                        })
                        print(f"  Загружено: {asset['name']} → {central_tag}")
                    except Exception as e:
                        print(f"  ОШИБКА при загрузке {asset['name']}: {e}")

            versions.append({
                "version": tag,
                "releaseDate": release["published_at"][:10],
                "assets": assets_info
            })

        products[product_id] = {
            "id": product_id,
            "name": meta["name"],
            "type": meta.get("type", "app"),
            "description": meta.get("description", "").strip(),
            "sourceAccount": f"https://github.com/{owner}",
            "sourceRepo": f"https://github.com/{repo}",
            "image": image_url,
            "video": meta.get("video"),
            "instructions": meta.get("instructions", "").strip(),
            "versions": versions
        }
        print(f"  Готово: {meta['name']}, версий: {len(versions)}")

    catalog = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "products": list(products.values())
    }
    CATALOG_FILE.write_text(json.dumps(catalog, ensure_ascii=False, indent=2))
    print("\ncatalog.json обновлён")


if __name__ == "__main__":
    main()
