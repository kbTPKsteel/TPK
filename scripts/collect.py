#!/usr/bin/env python3
import os, json, yaml, base64, subprocess
from pathlib import Path
from datetime import datetime, timezone
import requests

CENTRAL_REPO = "kbTPKsteel/TPK"
CATALOG_FILE = Path("catalog.json")
REPOS_FILE   = Path("repos.yml")
IMAGES_DIR   = Path("docs/images")


def api_get(url, token, accept="application/vnd.github+json"):
    r = requests.get(url, headers={"Authorization": f"token {token}", "Accept": accept})
    r.raise_for_status()
    return r.json()


def api_post(url, token, data):
    return requests.post(url, headers={
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github+json"
    }, json=data)


def get_all_repos(token):
    """Возвращает все репо, доступные по токену (включая приватные)."""
    repos, page = [], 1
    while True:
        batch = api_get(
            f"https://api.github.com/user/repos?visibility=all&per_page=100&page={page}",
            token
        )
        if not batch:
            break
        repos.extend(batch)
        page += 1
    return repos


def get_file_from_repo(repo, path, token):
    data = api_get(f"https://api.github.com/repos/{repo}/contents/{path}", token)
    return base64.b64decode(data["content"])


def download_asset(url, token, dest_path):
    r = requests.get(url, headers={
        "Authorization": f"token {token}",
        "Accept": "application/octet-stream"
    }, stream=True)
    r.raise_for_status()
    with open(dest_path, "wb") as f:
        for chunk in r.iter_content(8192):
            f.write(chunk)


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


def process_repo(repo_full_name, token, central_token, products):
    """Обрабатывает один репо. Возвращает True если продукт найден и обработан."""

    # Проверяем наличие catalog.yml
    try:
        raw = get_file_from_repo(repo_full_name, "catalog.yml", token)
        meta = yaml.safe_load(raw)
    except requests.HTTPError:
        return False  # нет catalog.yml — пропускаем молча
    except Exception as e:
        print(f"  ОШИБКА при чтении catalog.yml из {repo_full_name}: {e}")
        return False

    print(f"  Найден catalog.yml в {repo_full_name}")

    product_id = repo_full_name.replace("/", "-")
    owner = repo_full_name.split("/")[0]

    # Картинка
    image_url = None
    img_val = meta.get("image", "")
    if img_val.startswith("http"):
        image_url = img_val
    elif img_val:
        try:
            img_ext = Path(img_val).suffix
            img_dest = IMAGES_DIR / f"{product_id}{img_ext}"
            img_data = get_file_from_repo(repo_full_name, img_val, token)
            img_dest.write_bytes(img_data)
            image_url = f"https://raw.githubusercontent.com/{CENTRAL_REPO}/main/docs/images/{product_id}{img_ext}"
            print(f"    Картинка сохранена")
        except Exception as e:
            print(f"    ПРЕДУПРЕЖДЕНИЕ: не удалось получить картинку: {e}")

    # Релизы
    releases = api_get(f"https://api.github.com/repos/{repo_full_name}/releases", token)
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
                    print(f"    Загружено: {asset['name']}")
                except Exception as e:
                    print(f"    ОШИБКА при загрузке {asset['name']}: {e}")

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
        "sourceRepo": f"https://github.com/{repo_full_name}",
        "image": image_url,
        "video": meta.get("video"),
        "instructions": meta.get("instructions", "").strip(),
        "versions": versions
    }
    print(f"    Готово: {meta['name']}, версий: {len(versions)}")
    return True


def main():
    central_token = os.environ["GH_TOKEN"]
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    with open(REPOS_FILE) as f:
        config = yaml.safe_load(f)

    catalog = json.loads(CATALOG_FILE.read_text()) if CATALOG_FILE.exists() else {"products": []}
    products = {p["id"]: p for p in catalog.get("products", [])}

    for contributor in config["contributors"]:
        username = contributor["username"]
        token = os.environ.get(contributor["token_secret"], "")

        if not token:
            print(f"ПРОПУСК {username}: токен не найден ({contributor['token_secret']})")
            continue

        print(f"\nОбрабатываем участника: {username}")

        repos = get_all_repos(token)
        print(f"  Найдено репо: {len(repos)}")

        found = 0
        for repo in repos:
            if process_repo(repo["full_name"], token, central_token, products):
                found += 1

        print(f"  Продуктов с catalog.yml: {found}")

    catalog = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "products": list(products.values())
    }
    CATALOG_FILE.write_text(json.dumps(catalog, ensure_ascii=False, indent=2))
    print("\ncatalog.json обновлён")


if __name__ == "__main__":
    main()
