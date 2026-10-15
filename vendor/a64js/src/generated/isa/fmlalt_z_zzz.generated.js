export const ENCODINGS = [
    {
        "instructionId": "fmlalt_z_zzz",
        "encodingId": "fmlalt_z_zzz_",
        "mnemonic": "FMLALT",
        "className": "SVE2",
        "fileName": "fmlalt_z_zzz.xml",
        "mask": 4292934656,
        "value": 1688241152,
        "bitCount": 17,
        "fields": [
            {
                "name": "o2",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Zm",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "op",
                "lsb": 13,
                "width": 1
            },
            {
                "name": "T",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "Zn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Zda",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SVE2 || FEAT_SME"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-fmlal-long"
    }
];
