export const ENCODINGS = [
    {
        "instructionId": "zero_zt_i",
        "encodingId": "zero_zt_i_",
        "mnemonic": "ZERO",
        "className": "SME2",
        "fileName": "zero_zt_i.xml",
        "mask": 4294967295,
        "value": 3225944065,
        "bitCount": 32,
        "fields": [
            {
                "name": "opc",
                "lsb": 0,
                "width": 4
            }
        ],
        "features": [
            "FEAT_SME2"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sme-zero-zt"
    }
];
