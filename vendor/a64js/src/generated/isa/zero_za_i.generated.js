export const ENCODINGS = [
    {
        "instructionId": "zero_za_i",
        "encodingId": "zero_za_i_",
        "mnemonic": "ZERO",
        "className": "SME",
        "fileName": "zero_za_i.xml",
        "mask": 4294967040,
        "value": 3221749760,
        "bitCount": 24,
        "fields": [
            {
                "name": "imm8",
                "lsb": 0,
                "width": 8
            }
        ],
        "features": [
            "FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-zero-base"
    }
];
