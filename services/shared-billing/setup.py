from setuptools import setup, find_packages

setup(
    name="shared-billing",
    version="1.0.0",
    packages=find_packages(),
    install_requires=[
        "sqlalchemy>=2.0.0",
        "pydantic>=2.0.0",
        "python-dateutil>=2.8.0",
        "fpdf2>=2.7.0",
    ],
)
